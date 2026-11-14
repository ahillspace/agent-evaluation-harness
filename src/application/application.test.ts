import { targetFixture } from "../../tests/fixtures/runtime-targets.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentConfig,
  RuntimePort,
  RunView,
  BankRevision,
  EvaluatorDraft,
  EvaluatorRevision,
} from "../contracts.js";
import { createApplication } from "./application.js";
import { Database } from "../storage/database.js";
import { digest } from "../domain/identity.js";
import { TargetRegistry } from "../runtime/targets/registry.js";
import type { TargetAdapter } from "../runtime/targets/contracts.js";
import { managedCapabilities } from "../contracts/targets.js";
import { startServer } from "../server.js";

const agent: AgentConfig = {
  harness: "codex",
  model: "test",
  systemPrompt: "Answer the question.",
  settings: {},
  tools: [],
  connections: [],
};
function runtime(execute?: RuntimePort["execute"]): RuntimePort {
  return {
    ...targetFixture,
    resolveAgent: async (value) => value,
    discover: async () => ({
      harnesses: [],
      connectionProviders: [],
      maxConcurrency: 1,
    }),
    recover: async () => ({ recovered: [], errors: [] }),
    close: async () => {},
    listConnections: async () => [],
    saveConnection: async () => {
      throw new Error("Unused");
    },
    deleteConnection: async () => {},
    testConnection: async () => ({ ok: true, message: "ok" }),
    execute: execute ?? (async () => ({ answer: 42, text: "42" })),
    judge: async () => {
      throw new Error("Judge must stay disabled");
    },
    researcher: async () => {
      throw new Error("Unused");
    },
  };
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup(port = runtime()) {
  const directory = await mkdtemp(join(tmpdir(), "aeh-"));
  cleanups.push(() =>
    rm(directory, { recursive: true, force: true, maxRetries: 3 }),
  );
  const app = await createApplication({
    dataDirectory: directory,
    runtime: port,
  });
  cleanups.push(() => app.close());
  const bank = (await app.execute("banks.create", {
    name: "Bank",
    questions: [{ id: "q1", text: "What is the answer?", expected: 42 }],
  })) as BankRevision;
  return { app, bank, directory };
}
describe("shared application", () => {
  it("keeps a fatal resource stop explicit after its final answer is sealed", async () => {
    const { app, bank } = await setup(
      runtime(async () => ({
        answer: 42,
        text: "42",
        cleanup: "unavailable",
        evidenceScope: "internal-activity",
      })),
    );
    const launched = await app.execute("runs.launch", {
      bankRevisionId: bank.id,
      agent,
    });
    await app.waitForIdle();
    const view = await app.execute("runs.get", { runId: launched.run.id });
    expect(view.run).toMatchObject({
      status: "halted",
      intent: "halt",
      execution: { stopReason: "failed" },
    });
    expect(view.progress.completed).toBe(1);
    expect(view.assessmentPasses![0]!.coverage.correct).toBe(1);
    expect(view.run.error).toMatch(/cleanup/i);
  });
  it.each(["unavailable-output", "cleanup-failed"] as const)(
    "keeps acknowledged Cancel terminal after late %s through the real registry and HTTP",
    async (mode) => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const adapter: TargetAdapter = {
        id: "managed",
        version: 1,
        capabilities: managedCapabilities,
        validate: (target) => target,
        resolve: async (target) => target,
        recover: async () => ({
          cleanup: "complete",
          remoteCompletion: "unknown",
        }),
        close: async () => {},
        invoke: async (input) => {
          entered();
          await gate;
          expect(input.signal.aborted).toBe(true);
          if (mode === "cleanup-failed")
            throw Object.assign(new Error("Late cleanup failure"), {
              code: "cleanup_failed",
            });
          return {
            answer: 42,
            text: "42",
            evidenceScope: "internal-activity",
            cleanup: "unavailable",
          };
        },
      };
      const registry = new TargetRegistry([adapter], 1);
      const port = runtime();
      port.resolveTarget = (target) => registry.resolve(target);
      port.execute = (input) => registry.invoke(input);
      port.recoverTarget = (target, checkpoint) =>
        registry.recover(target, checkpoint);
      port.close = () => registry.close();
      const { app, bank } = await setup(port);
      const server = await startServer({
        application: app,
        port: 0,
        host: "127.0.0.1",
      });
      cleanups.push(() => server.close());
      const post = async (operation: string, input: unknown) => {
        const response = await fetch(
          `${server.url}/api/commands/${operation}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          },
        );
        const body = await response.json();
        expect(response.status, JSON.stringify(body)).toBe(200);
        return body as RunView;
      };
      try {
        const launched = await post("runs.launch", {
          bankRevisionId: bank.id,
          agent,
        });
        await started;
        const receipt = await post("runs.control", {
          runId: launched.run.id,
          action: "cancel",
        });
        expect(receipt.run.intent).toBe("cancel");
        release();
        await app.waitForIdle();
        const settled = await post("runs.get", { runId: launched.run.id });
        expect(settled.run).toMatchObject({
          status: "cancelled",
          intent: "cancel",
        });
        expect(settled.run.error).toMatch(/cleanup/i);
        expect(settled.retryEligibility?.available).toBe(false);
        expect(settled.resumeEligibility?.available).toBe(false);
        expect(settled.allowedActions).toEqual([]);
        expect(settled.progress.completed).toBe(
          mode === "unavailable-output" ? 1 : 0,
        );
      } finally {
        release();
      }
    },
  );
  it.each(["pause", "halt", "cancel"] as const)(
    "settles a final saved answer under %s while preserving Cancel precedence",
    async (action) => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { app, bank } = await setup(
        runtime(async () => {
          entered();
          await gate;
          return { answer: 42, text: "42" };
        }),
      );
      const launch = await app.execute("runs.launch", {
        bankRevisionId: bank.id,
        agent,
      });
      await started;
      try {
        await app.execute("runs.control", { runId: launch.run.id, action });
      } finally {
        release();
      }
      await app.waitForIdle();
      const settled = await app.execute("runs.get", { runId: launch.run.id });
      expect(settled.run.status).toBe(
        action === "cancel" ? "cancelled" : "completed",
      );
      expect(settled.progress.completed).toBe(1);
      expect(settled.run.execution?.id).toBe(launch.run.id);
      expect(settled.run.execution?.settledAt).toBeDefined();
      expect(settled.assessmentPasses).toHaveLength(1);
    },
  );
  it("rejects recovery when frozen target resolution changes instead of adopting the new configuration", async () => {
    let calls = 0;
    const port = runtime(async () => {
      calls++;
      throw Object.assign(new Error("Fixture failure"), {
        code: "target_failure",
      });
    });
    const { app, bank } = await setup(port);
    const launched = await app.execute("runs.launch", {
      bankRevisionId: bank.id,
      agent,
    });
    await app.waitForIdle();
    const before = await app.execute("runs.get", { runId: launched.run.id });
    port.resolveAgent = async (value) => ({ ...value, model: "changed-model" });
    await expect(
      app.execute("runs.retry-failed", {
        runId: launched.run.id,
        acknowledgeDuplicateWork: true,
        idempotencyKey: "changed-frozen-target",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const after = await app.execute("runs.get", { runId: launched.run.id });
    expect(after.run).toEqual(before.run);
    expect(after.attempts).toEqual(before.attempts);
    expect(calls).toBe(1);
  });
  it("lists compact live score metadata without reading full manifests, attempts, or judgments", async () => {
    const { app, bank } = await setup(
      runtime(async () => ({
        answer: 42,
        text: "PRIVATE_EVIDENCE".repeat(10000),
      })),
    );
    const launched = await app.execute("runs.launch", {
      bankRevisionId: bank.id,
      agent: { ...agent, systemPrompt: "PRIVATE_CONFIGURATION".repeat(4000) },
    });
    await app.waitForIdle();
    const full = Database.prototype.get,
      list = Database.prototype.list;
    const getSpy = vi
      .spyOn(Database.prototype, "get")
      .mockImplementation(function (this: Database, kind, recordId) {
        if (
          [
            "run",
            "attempt",
            "assessment",
            "scoreSet",
            "assessmentPass",
          ].includes(kind)
        )
          throw new Error(`Full ${kind} read during run listing`);
        return full.call(this, kind, recordId);
      });
    const listSpy = vi
      .spyOn(Database.prototype, "list")
      .mockImplementation(function (this: Database, kind, query) {
        if (
          [
            "run",
            "attempt",
            "assessment",
            "scoreSet",
            "assessmentPass",
          ].includes(kind)
        )
          throw new Error(`Full ${kind} scan during run listing`);
        return list.call(this, kind, query);
      });
    try {
      const page = await app.execute("runs.list", { limit: 1 });
      expect(page.runs[0]).toMatchObject({
        id: launched.run.id,
        completed: 1,
        failed: 0,
        graded: 1,
        accuracy: 1,
        targetKind: "managed",
      });
      expect(JSON.stringify(page)).not.toContain("PRIVATE_");
      expect(JSON.stringify(page).length).toBeLessThan(5000);
      expect(page.runs[0]).not.toHaveProperty("target");
      expect(page.runs[0]).not.toHaveProperty("performance");
    } finally {
      getSpy.mockRestore();
      listSpy.mockRestore();
    }
  });
  it("filters all saved runs before pagination with matching Unicode search", async () => {
    const { app, bank } = await setup();
    const other = await app.execute("banks.create", {
      name: "Other",
      questions: [{ id: "q", text: "Question", expected: 42 }],
    });
    const ids: string[] = [];
    for (const name of ["CAF\u00c9 first", "Cafe\u0301 second", "Unrelated"]) {
      const launched = await app.execute("runs.launch", {
        name,
        bankRevisionId: bank.id,
        agent,
      });
      ids.push(launched.run.id);
      await app.waitForIdle();
    }
    await app.execute("runs.launch", {
      name: "CAF\u00c9 other bank",
      bankRevisionId: other.id,
      agent,
    });
    await app.waitForIdle();
    const first = await app.execute("runs.list", {
      bankId: bank.bankId,
      status: "completed",
      search: "caf\u00e9",
      limit: 1,
    });
    expect(first.total).toBe(2);
    expect(first.runs.map((run) => run.id)).toEqual([ids[1]]);
    expect(first.nextOffset).toBe(1);
    const second = await app.execute("runs.list", {
      bankId: bank.bankId,
      status: "completed",
      search: "cafe\u0301",
      limit: 1,
      offset: first.nextOffset!,
    });
    expect(second.runs.map((run) => run.id)).toEqual([ids[0]]);
    expect(second.nextOffset).toBeNull();
    expect(
      (await app.execute("runs.list", { bankId: other.bankId })).runs,
    ).toHaveLength(1);
    expect((await app.execute("runs.list", { status: "failed" })).total).toBe(
      0,
    );
  });

  it("calibrates positive and negative examples before evaluator publication", async () => {
    const { app, bank } = await setup();
    const draft = await app.execute("evaluators.draft", {
      bankId: bank.bankId,
      name: "Calibrated",
      settings: {
        calibrationExamples: [
          {
            id: "positive",
            questionId: "q1",
            answer: 42,
            expectedStatus: "correct",
          },
          {
            id: "negative",
            questionId: "q1",
            answer: 43,
            expectedStatus: "incorrect",
          },
        ],
      },
    });
    const report = await app.execute("evaluators.calibrate", {
      draftId: draft.id,
    });
    expect(report).toMatchObject({
      bankRevisionId: bank.id,
      total: 2,
      passed: 2,
    });
    const published = await app.execute("evaluators.publish", {
      draftId: draft.id,
    });
    expect(published.calibration).toEqual(report);
    const permissive = await app.execute("evaluators.draft", {
      bankId: bank.bankId,
      name: "Too permissive",
      settings: { ...draft.settings, absoluteTolerance: 10 },
    });
    await expect(
      app.execute("evaluators.publish", { draftId: permissive.id }),
    ).rejects.toThrow(/calibration/i);
    const detail = await app.execute("banks.get", { bankId: bank.bankId });
    expect(detail.evaluatorRevisions).toHaveLength(2);
    const run = await app.execute("runs.launch", {
      bankRevisionId: bank.id,
      evaluatorRevisionId: published.id,
      agent,
    });
    await app.waitForIdle();
    const observed = await app.execute("runs.observe", { runId: run.run.id });
    expect(observed.assessmentPasses![0]).not.toHaveProperty("configuration");
    const assessment = await app.execute("runs.assessment", {
      runId: run.run.id,
      passId: observed.assessmentPasses![0]!.id,
    });
    expect(assessment.configuration.evaluator?.calibration).toEqual(
      published.calibration,
    );
  });
  it("checks calibration against the latest bank and rejects unknown example questions", async () => {
    const { app, bank } = await setup();
    const draft = await app.execute("evaluators.draft", {
      bankId: bank.bankId,
      name: "Old example",
      settings: {
        calibrationExamples: [
          {
            id: "known",
            questionId: "q1",
            answer: 42,
            expectedStatus: "correct",
          },
        ],
      },
    });
    await app.execute("banks.revise", {
      bankId: bank.bankId,
      baseRevisionId: (await app.execute("banks.get", { bankId: bank.bankId }))
        .bank.latestRevisionId,
      baseEvaluatorRevisionId: (
        await app.execute("banks.get", { bankId: bank.bankId })
      ).bank.activeEvaluatorRevisionId,
      name: bank.name,
      questions: bank.questions.map((q) => ({ ...q, expected: 43 })),
    });
    await expect(
      app.execute("evaluators.publish", { draftId: draft.id }),
    ).rejects.toThrow(/calibration/i);
    const bad = await app.execute("evaluators.draft", {
      bankId: bank.bankId,
      name: "Unknown question",
      settings: {
        calibrationExamples: [
          {
            id: "missing",
            questionId: "absent",
            answer: 42,
            expectedStatus: "correct",
          },
        ],
      },
    });
    await expect(
      app.execute("evaluators.calibrate", { draftId: bad.id }),
    ).rejects.toThrow(/unknown question/i);
  });
  it("rejects publication when reference revisions change during calibration", async () => {
    const { app, bank } = await setup();
    const draft = await app.execute("evaluators.draft", {
      bankId: bank.bankId,
      name: "Concurrent calibration",
      settings: {
        calibrationExamples: [
          {
            id: "known",
            questionId: "q1",
            answer: 42,
            expectedStatus: "correct",
          },
        ],
      },
    });
    const publication = app.execute("evaluators.publish", {
      draftId: draft.id,
    });
    const rejected = expect(publication).rejects.toThrow(
      /changed during calibration/i,
    );
    await app.execute("banks.revise", {
      bankId: bank.bankId,
      baseRevisionId: (await app.execute("banks.get", { bankId: bank.bankId }))
        .bank.latestRevisionId,
      baseEvaluatorRevisionId: (
        await app.execute("banks.get", { bankId: bank.bankId })
      ).bank.activeEvaluatorRevisionId,
      name: bank.name,
      questions: bank.questions,
    });
    await rejected;
    expect(
      (await app.execute("banks.get", { bankId: bank.bankId }))
        .evaluatorRevisions,
    ).toHaveLength(2);
  });
  it("rejects malformed typed references before publication", async () => {
    const { app, bank } = await setup();
    const invalid = [
      {
        id: "bad",
        text: "Count",
        expected: {
          type: "table",
          columns: [{ name: "count", type: "integer", nullable: false }],
          rows: [{ count: "not an integer" }],
        },
      },
    ];
    await expect(
      app.execute("banks.create", { name: "Invalid", questions: invalid }),
    ).rejects.toThrow(/bad|reference|integer|row/i);
    await expect(
      app.execute("banks.revise", {
        bankId: bank.bankId,
        baseRevisionId: (
          await app.execute("banks.get", { bankId: bank.bankId })
        ).bank.latestRevisionId,
        baseEvaluatorRevisionId: (
          await app.execute("banks.get", { bankId: bank.bankId })
        ).bank.activeEvaluatorRevisionId,
        name: bank.name,
        questions: invalid,
      }),
    ).rejects.toThrow(/bad|reference|integer|row/i);
    const detail = await app.execute("banks.get", { bankId: bank.bankId });
    expect(detail.revisions).toHaveLength(1);
  });
  it("rejects unknown question override IDs before publication", async () => {
    const { app, bank } = await setup();
    const settings = { questionOverrides: { typo: { absoluteTolerance: 1 } } };
    await expect(
      app.execute("banks.create", {
        name: "Bad override",
        questions: bank.questions,
        evaluator: settings,
      }),
    ).rejects.toThrow(/unknown question/i);
    const draft = await app.execute<"evaluators.draft">("evaluators.draft", {
      bankId: bank.bankId,
      name: "Typo",
      settings,
    });
    await expect(
      app.execute("evaluators.publish", { draftId: draft.id }),
    ).rejects.toThrow(/unknown question/i);
  });
  it("rescoring explicitly selects corrected references without changing target evidence", async () => {
    const { app, bank } = await setup(
      runtime(async () => ({ answer: 43, text: "43" })),
    );
    const launched = await app.execute("runs.launch", {
      bankRevisionId: bank.id,
      agent,
    });
    await app.waitForIdle();
    const before = await app.execute("runs.get", { runId: launched.run.id });
    const corrected = await app.execute("banks.revise", {
      bankId: bank.bankId,
      baseRevisionId: (await app.execute("banks.get", { bankId: bank.bankId }))
        .bank.latestRevisionId,
      baseEvaluatorRevisionId: (
        await app.execute("banks.get", { bankId: bank.bankId })
      ).bank.activeEvaluatorRevisionId,
      name: bank.name,
      questions: bank.questions.map((q) => ({ ...q, expected: 43 })),
    });
    const evaluatorId = before.run.manifest.evaluator.id;
    const frozen = await app.execute("runs.assess", {
      source: "deterministic",
      name: "Saved answer rules",
      runId: launched.run.id,
      evaluatorRevisionId: evaluatorId,
    });
    expect(frozen.judgments[0]?.status).toBe("incorrect");
    const scores = await app.execute("runs.assess", {
      source: "deterministic",
      name: "Saved answer rules",
      runId: launched.run.id,
      evaluatorRevisionId: evaluatorId,
      bankRevisionId: corrected.id,
    });
    expect(scores.judgments[0]?.status).toBe("correct");
    expect(scores.configuration.referenceBank).toEqual(corrected);
    const after = await app.execute("runs.get", { runId: launched.run.id });
    expect(after.run.manifest).toEqual(before.run.manifest);
    expect(after.attempts).toEqual(before.attempts);
    expect(
      after.assessmentPasses!.find((s) => s.id === scores.id),
    ).not.toHaveProperty("questions");
    const second = await app.execute("runs.launch", {
      bankRevisionId: bank.id,
      agent,
    });
    await app.waitForIdle();
    const comparison = await app.execute("runs.compare", {
      runIds: [launched.run.id, second.run.id],
      evaluatorRevisionId: evaluatorId,
    });
    expect(comparison.comparable).toBe(false);
    expect(comparison.rows[0]?.questionDigest).not.toBe(
      comparison.rows[1]?.questionDigest,
    );
    const draft = await app.execute("evaluators.draft", {
      bankId: bank.bankId,
      name: "Preview corrected",
      settings: {},
    });
    const preview = await app.execute("evaluators.preview", {
      draftId: draft.id,
      runIds: [launched.run.id],
      bankRevisionId: corrected.id,
    });
    expect(preview.runs[0]?.rows[0]).toMatchObject({
      expected: 43,
      after: { status: "correct" },
    });
    const other = await app.execute("banks.create", {
      name: "Other",
      questions: corrected.questions,
    });
    await expect(
      app.execute("runs.assess", {
        source: "deterministic",
        name: "Saved answer rules",
        runId: launched.run.id,
        evaluatorRevisionId: evaluatorId,
        bankRevisionId: other.id,
      }),
    ).rejects.toThrow(/another bank/i);
    const changed = await app.execute("banks.revise", {
      bankId: bank.bankId,
      baseRevisionId: (await app.execute("banks.get", { bankId: bank.bankId }))
        .bank.latestRevisionId,
      baseEvaluatorRevisionId: (
        await app.execute("banks.get", { bankId: bank.bankId })
      ).bank.activeEvaluatorRevisionId,
      name: bank.name,
      questions: corrected.questions.map((q) => ({
        ...q,
        text: "Different task",
      })),
    });
    await expect(
      app.execute("runs.assess", {
        source: "deterministic",
        name: "Saved answer rules",
        runId: launched.run.id,
        evaluatorRevisionId: evaluatorId,
        bankRevisionId: changed.id,
      }),
    ).rejects.toThrow(/question|context/i);
  });
  it("excludes contested references from accuracy while reporting their coverage", async () => {
    const { app, bank } = await setup();
    const draft = await app.execute("evaluators.draft", {
      bankId: bank.bankId,
      name: "Reference under review",
      settings: {
        referenceDisposition: "needs_review",
        referenceNote: "Source scope is disputed",
      },
    });
    const evaluator = await app.execute("evaluators.publish", {
      draftId: draft.id,
      activate: true,
    });
    const launched = await app.execute("runs.launch", {
      bankRevisionId: bank.id,
      evaluatorRevisionId: evaluator.id,
      agent,
    });
    await app.waitForIdle();
    const list = await app.execute("runs.list", {});
    expect(list.runs[0]).toMatchObject({
      unscorable: 1,
      graded: 0,
      accuracy: null,
    });
    const second = await app.execute("runs.launch", {
      bankRevisionId: bank.id,
      agent,
    });
    await app.waitForIdle();
    const comparison = await app.execute("runs.compare", {
      runIds: [launched.run.id, second.run.id],
    });
    expect(comparison.rows[0]).toMatchObject({
      unscorable: 1,
      graded: 0,
      accuracy: null,
    });
    expect(comparison.comparable).toBe(false);
  });
  it("keeps the historical public boundary when a stored revision has no answer format", async () => {
    let received: unknown;
    const port = runtime(async (input) => {
      received = input.question;
      return { answer: [{ count: 3 }], text: "3" };
    });
    const { app, bank, directory } = await setup(port);
    const questions: BankRevision["questions"] = [
      {
        id: "legacy",
        text: "Count",
        tags: [],
        expected: {
          type: "table",
          columns: [{ name: "count", type: "integer" }],
          rows: [{ count: 3 }],
        },
      },
    ];
    const legacy = {
      ...bank,
      id: "legacy-published-bank",
      number: 2,
      questions,
      digest: digest(questions),
    };
    const db = new Database(join(directory, "workspace.sqlite"));
    db.insert("bankRevision", legacy);
    db.close();
    const launched = await app.execute("runs.launch", {
      bankRevisionId: legacy.id,
      agent,
    });
    await app.waitForIdle();
    expect(received).not.toHaveProperty("answerFormat");
    expect(launched.run.manifest.bank).toEqual(legacy);
    expect(
      (await app.execute("banks.export", { bankRevisionId: legacy.id }))
        .questions,
    ).toEqual(questions);
  });
  it("freezes a public table format at bank publication and sends no reference values to the target", async () => {
    let received: unknown;
    const port = runtime(async (input) => {
      received = input.question;
      return { answer: [{ country: "A", invoices: 3 }], text: "Done" };
    });
    const { app } = await setup(port);
    const bank = await app.execute("banks.create", {
      name: "Public table format",
      questions: [
        {
          id: "table",
          text: "Count invoices per country",
          expected: {
            type: "table",
            columns: [
              { name: "country", type: "string", nullable: false },
              { name: "invoices", type: "integer", nullable: false },
            ],
            rows: [{ country: "PRIVATE_REFERENCE_COUNTRY", invoices: 99 }],
            ordered: true,
          },
        },
      ],
    });
    expect(bank.questions[0]?.answerFormat).toEqual({
      type: "table",
      columns: [
        { name: "country", type: "string", nullable: true },
        { name: "invoices", type: "integer", nullable: true },
      ],
    });
    const run = await app.execute("runs.launch", {
      bankRevisionId: bank.id,
      agent,
    });
    await app.waitForIdle();
    expect(received).toMatchObject({
      id: "table",
      answerFormat: bank.questions[0]?.answerFormat,
    });
    expect(JSON.stringify(received)).not.toMatch(
      /PRIVATE_REFERENCE|99|ordered|expected/,
    );
    const next = await app.execute("banks.revise", {
      bankId: bank.bankId,
      baseRevisionId: (await app.execute("banks.get", { bankId: bank.bankId }))
        .bank.latestRevisionId,
      baseEvaluatorRevisionId: (
        await app.execute("banks.get", { bankId: bank.bankId })
      ).bank.activeEvaluatorRevisionId,
      name: "New question",
      questions: [{ id: "table", text: "Answer", expected: 42 }],
    });
    expect(next.questions[0]?.answerFormat).toBeUndefined();
    const saved = await app.execute("runs.get", { runId: run.run.id });
    expect(saved.run.manifest.questions[0]?.answerFormat).toEqual(
      bank.questions[0]?.answerFormat,
    );
  });
  it("allows public nullability widening, preserves explicit restrictions, and rejects narrowing", async () => {
    const { app } = await setup();
    for (const nullable of [false, true]) {
      const bank = await app.execute("banks.create", {
        name: "Authored nullability",
        questions: [
          {
            id: "q",
            text: "List states",
            answerFormat: {
              type: "table",
              columns: [{ name: "state", type: "string", nullable }],
            },
            expected: {
              type: "table",
              columns: [{ name: "state", type: "string", nullable: false }],
              rows: [{ state: "CA" }],
            },
          },
        ],
      });
      expect(bank.questions[0]?.answerFormat).toMatchObject({
        columns: [{ nullable }],
      });
      expect(bank.questions[0]?.expected).toMatchObject({
        columns: [{ nullable: false }],
      });
      const next = await app.execute("banks.revise", {
        bankId: bank.bankId,
        baseRevisionId: (
          await app.execute("banks.get", { bankId: bank.bankId })
        ).bank.latestRevisionId,
        baseEvaluatorRevisionId: (
          await app.execute("banks.get", { bankId: bank.bankId })
        ).bank.activeEvaluatorRevisionId,
        name: "New derived revision",
        questions: [
          {
            id: "q",
            text: "List states",
            expected: bank.questions[0]!.expected,
          },
        ],
      });
      expect(next.questions[0]?.answerFormat).toMatchObject({
        columns: [{ nullable: true }],
      });
      const saved = await app.execute("banks.export", {
        bankRevisionId: bank.id,
      });
      expect(saved.questions[0]?.answerFormat).toMatchObject({
        columns: [{ nullable }],
      });
    }
    await expect(
      app.execute("banks.create", {
        name: "Narrowed nullability",
        questions: [
          {
            id: "q",
            text: "List states",
            answerFormat: {
              type: "table",
              columns: [{ name: "state", type: "string", nullable: false }],
            },
            expected: {
              type: "table",
              columns: [{ name: "state", type: "string", nullable: true }],
              rows: [{ state: null }],
            },
          },
        ],
      }),
    ).rejects.toThrow(/format.*reference|reference.*format/i);
  });
  it("rejects an explicit public format that conflicts with reference columns", async () => {
    const { app } = await setup();
    await expect(
      app.execute("banks.create", {
        name: "Conflicting format",
        questions: [
          {
            id: "q",
            text: "Count",
            answerFormat: {
              type: "table",
              columns: [{ name: "public_name", type: "integer" }],
            },
            expected: {
              type: "table",
              columns: [{ name: "different_name", type: "integer" }],
              rows: [{ different_name: 42 }],
            },
          },
        ],
      }),
    ).rejects.toThrow(/format.*reference|reference.*format/i);
  });
  it("drains admitted commands before releasing runtime resources and ownership", async () => {
    const port = runtime();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let runtimeClosed = false;
    port.saveConnection = async (input) => {
      entered();
      await gate;
      expect(runtimeClosed).toBe(false);
      return {
        id: "connection",
        name: input.name,
        provider: input.provider,
        settings: input.settings,
        credentialFields: [],
        hasCredentials: false,
      };
    };
    port.close = async () => {
      runtimeClosed = true;
    };
    const { app } = await setup(port);
    const saving = app.execute("connections.save", {
      name: "Connection",
      settings: {},
    });
    await started;
    const closing = app.close();
    expect(app.close()).toBe(closing);
    await expect(app.execute("workspace.get", {})).rejects.toThrow(/closed/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtimeClosed).toBe(false);
    release();
    await saving;
    await closing;
    expect(runtimeClosed).toBe(true);
  });
  it("keeps observation polls bounded and loads selected evidence through scoped reads", async () => {
    const payload = "large-evidence-" + "x".repeat(100_000);
    const { app, bank } = await setup(
      runtime(async ({ onEvent }) => {
        onEvent({
          type: "tool.completed",
          message: "Query completed.",
          data: { payload },
        });
        return {
          answer: 42,
          text: "42",
          transcript: { payload },
          usage: { inputTokens: 12, outputTokens: 3 },
        };
      }),
    );
    const created = await app.execute("runs.launch", {
      bankRevisionId: bank.id,
      agent,
    });
    await app.waitForIdle();
    const snapshot = await app.execute("runs.get", { runId: created.run.id });
    const observation = await app.execute("runs.observe", {
      runId: created.run.id,
    });
    expect(JSON.stringify(snapshot)).not.toContain("large-evidence-");
    expect(JSON.stringify(observation).length).toBeLessThan(15_000);
    expect(observation.run).not.toHaveProperty("manifest");
    expect(snapshot.attempts[0]?.usage?.inputTokens).toBe(12);
    const attemptId = snapshot.attempts[0]!.id;
    const detail = await app.execute("runs.attempt", {
      runId: created.run.id,
      attemptId,
    });
    expect(detail.attempt.output?.transcript).toEqual({ payload });
    const events = await app.execute("runs.attempt-events", {
      runId: created.run.id,
      attemptId,
    });
    expect(
      events.events.some((event) =>
        JSON.stringify(event.data).includes("large-evidence-"),
      ),
    ).toBe(true);
    expect(
      (
        await app.execute("runs.attempt-events", {
          runId: created.run.id,
          attemptId,
          cursor: events.cursor,
        })
      ).events,
    ).toHaveLength(0);
  });
  it("keeps evaluator explanations behind explicit audited gold retrieval", async () => {
    const port = runtime();
    const sentinel = "PRIVATE_GOLD_SENTINEL";
    port.researcher = async (input) => {
      const initial = JSON.parse(input.message) as {
        baselineRun: { runId: string };
      };
      const evidence = await input.readEvidence({
        runId: initial.baselineRun.runId,
      });
      expect(JSON.stringify(evidence)).not.toContain(sentinel);
      const gold = await input.readEvidence({
        runId: initial.baselineRun.runId,
        includeGold: true,
      });
      expect(JSON.stringify(gold)).toContain(sentinel);
      return {
        conversationId: "conversation",
        message: "Done",
        decision: "stop",
      };
    };
    const { app } = await setup(port);
    const bank = await app.execute("banks.create", {
      name: "Private gold",
      questions: [
        { id: "q", text: "Answer the question.", expected: sentinel },
      ],
      evaluator: {
        mode: "custom",
        code: "return {verdict: true, explanation: input.expected};",
      },
    });
    const created = await app.execute("research.launch", {
      baseline: { bankRevisionId: bank.id, agent },
      researcher: agent,
      objective: "Improve accuracy.",
    });
    await app.waitForIdle();
    const session = await app.execute("research.get", {
      sessionId: created.session.id,
    });
    expect(session.session.status).toBe("completed");
    expect(
      session.events.filter(
        (event) => event.type === "research.gold.retrieved",
      ),
    ).toHaveLength(1);
  });
  it("releases ownership and closes runtime resources after startup and shutdown failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aeh-errors-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const port = runtime();
    let closed = 0;
    port.close = async () => {
      closed++;
    };
    port.recover = async () => ({
      recovered: [],
      errors: ["Stale process cleanup failed."],
    });
    await expect(
      createApplication({ dataDirectory: directory, runtime: port }),
    ).rejects.toThrow(/cleanup/i);
    expect(closed).toBe(1);
    const brokenClose = runtime();
    brokenClose.close = async () => {
      throw new Error("Close failed.");
    };
    const app = await createApplication({
      dataDirectory: directory,
      runtime: brokenClose,
    });
    await expect(app.close()).rejects.toThrow(/cleanup/i);
    const recovered = await createApplication({
      dataDirectory: directory,
      runtime: runtime(),
    });
    await recovered.close();
  });
  it("stops admissions after infrastructure failure and preserves successful evidence", async () => {
    let calls = 0;
    const { app, bank } = await setup(
      runtime(async () => {
        calls++;
        if (calls === 2)
          throw Object.assign(new Error("Tableau MCP could not start."), {
            code: "infrastructure_failure",
          });
        return { answer: 42, text: "42" };
      }),
    );
    const run = (await app.execute("runs.launch", {
      bankRevisionId: bank.id,
      agent,
      repetitions: 4,
    })) as RunView;
    await app.waitForIdle();
    const view = (await app.execute("runs.get", {
      runId: run.run.id,
    })) as RunView;
    expect(view.run.status).toBe("failed");
    expect(view.run.error).toContain("Tableau MCP");
    expect(calls).toBe(2);
    expect(view.results.map((r) => r.status)).toEqual([
      "completed",
      "failed",
      "pending",
      "pending",
    ]);
    expect(view.assessmentPasses![0]?.coverage.judged).toBe(1);
    const listed = await app.execute("runs.list", {});
    expect(listed.runs.find((item) => item.id === run.run.id)).toMatchObject({
      completed: 1,
      failed: 1,
      total: 4,
      graded: 1,
      accuracy: 1,
    });
    const other = await app.execute("runs.launch", {
      bankRevisionId: bank.id,
      agent,
    });
    await app.waitForIdle();
    const compared = await app.execute("runs.compare", {
      runIds: [run.run.id, other.run.id],
    });
    expect(compared.rows[0]?.assessmentPass?.judgedAccuracy).toBe(1);
    expect(compared.rows[0]).toMatchObject({
      completed: 1,
      failed: 1,
      total: 4,
      graded: 1,
      accuracy: 1,
    });
  });
  it("acknowledges pause after active work drains and ignores late provider events", async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lateEvent: (() => void) | undefined;
    let count = 0;
    const { app, bank } = await setup(
      runtime(async (input) => {
        count++;
        if (count === 1) {
          input.onEvent({ type: "tool.started", message: "Query started." });
          lateEvent = () =>
            input.onEvent({ type: "tool.completed", message: "Stale event." });
          started();
          await gate;
        }
        return { answer: 42, text: "42" };
      }),
    );
    const run = await app.execute("runs.launch", {
      bankRevisionId: bank.id,
      agent,
      repetitions: 2,
    });
    await entered;
    const pending = await app.execute("runs.control", {
      runId: run.run.id,
      action: "pause",
    });
    expect(pending.run.status).toBe("pausing");
    expect(
      (await app.execute("runs.events", { runId: run.run.id })).events.some(
        (event) => event.type === "tool.started",
      ),
    ).toBe(true);
    release();
    await app.waitForIdle();
    const paused = await app.execute("runs.get", { runId: run.run.id });
    expect(paused.run.status).toBe("paused");
    expect(paused.progress.completed).toBe(1);
    const history = await app.execute("runs.events", { runId: run.run.id });
    lateEvent?.();
    expect(await app.execute("runs.events", { runId: run.run.id })).toEqual(
      history,
    );
    await app.execute("runs.control", { runId: run.run.id, action: "resume" });
    await app.waitForIdle();
    expect(
      (await app.execute("runs.get", { runId: run.run.id })).progress.completed,
    ).toBe(2);
    expect(count).toBe(2);
  });
  it("keeps cleanup failure fatal even when Halt already interrupted the provider", async () => {
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { app, bank } = await setup(
      runtime(async ({ signal }) => {
        started();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw Object.assign(new Error("Process cleanup failed."), {
          code: "cleanup_failed",
        });
      }),
    );
    const run = await app.execute("runs.launch", {
      bankRevisionId: bank.id,
      agent,
    });
    await entered;
    await app.execute("runs.control", { runId: run.run.id, action: "halt" });
    await app.waitForIdle();
    const view = await app.execute("runs.get", { runId: run.run.id });
    expect(view.run.status).toBe("failed");
    expect(view.run.error).toContain("cleanup failed");
    expect(view.allowedActions).not.toContain("resume");
  });
  it("freezes launches, excludes gold from targets and exports, and honors idempotency", async () => {
    const inputs: unknown[] = [];
    const { app, bank } = await setup(
      runtime(async (input) => {
        inputs.push(input.question);
        return { answer: 42, text: "42" };
      }),
    );
    const input = {
      bankRevisionId: bank.id,
      agent,
      repetitions: 2,
      idempotencyKey: "stable",
    };
    const first = (await app.execute("runs.launch", input)) as RunView;
    const duplicate = (await app.execute("runs.launch", input)) as RunView;
    expect(duplicate.run.id).toBe(first.run.id);
    await app.waitForIdle();
    const view = (await app.execute("runs.get", {
      runId: first.run.id,
    })) as RunView;
    expect(view.run.status).toBe("completed");
    expect(view.results).toHaveLength(2);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).not.toHaveProperty("expected");
    expect(
      view.assessmentPasses![0]?.judgments.every((a) => a.status === "correct"),
    ).toBe(true);
    const exported = await app.execute("runs.export-agent", {
      runId: first.run.id,
    });
    expect(JSON.stringify(exported)).not.toContain("expected");
    await expect(
      app.execute("runs.launch", { ...input, repetitions: 3 }),
    ).rejects.toThrow(/idempotency/i);
  });
  it("exports credential placeholders without retained workspace references", async () => {
    const { app, bank } = await setup();
    const credentialBinding = {
      version: 1 as const,
      reference: "private-workspace-reference",
      identity: "a".repeat(64),
    };
    const run = await app.execute("runs.launch", {
      bankRevisionId: bank.id,
      agent: {
        ...agent,
        connections: [
          {
            connectionId: "provider",
            provider: "openai",
            settings: {},
            credentialFields: ["apiKey"],
            credentialBinding,
          },
        ],
      },
    });
    await app.waitForIdle();
    const before = JSON.stringify(
      (await app.execute("runs.get", { runId: run.run.id })).run.manifest,
    );
    const exported = await app.execute("runs.export-agent", {
      runId: run.run.id,
    });
    expect(JSON.stringify(exported)).toContain("${OPENAI_APIKEY}");
    expect(JSON.stringify(exported)).not.toContain("credentialBinding");
    expect(JSON.stringify(exported)).not.toContain(credentialBinding.reference);
    expect(
      JSON.stringify(
        (await app.execute("runs.get", { runId: run.run.id })).run.manifest,
      ),
    ).toBe(before);
    expect(before).toContain(credentialBinding.reference);
  });
  it("rescores immutable saved evidence after preview and evaluator publication", async () => {
    const { app, bank } = await setup(
      runtime(async () => ({ answer: 42.05, text: "42.05" })),
    );
    const run = (await app.execute("runs.launch", {
      bankRevisionId: bank.id,
      agent,
    })) as RunView;
    await app.waitForIdle();
    const before = (await app.execute("runs.get", {
      runId: run.run.id,
    })) as RunView;
    expect(before.assessmentPasses![0]?.judgments[0]?.status).toBe("incorrect");
    const draft = (await app.execute("evaluators.draft", {
      bankId: bank.bankId,
      name: "Tolerance",
      settings: { mode: "numeric", absoluteTolerance: 0.1 },
    })) as EvaluatorDraft;
    await app.execute("evaluators.preview", {
      draftId: draft.id,
      runIds: [run.run.id],
    });
    const revision = (await app.execute("evaluators.publish", {
      draftId: draft.id,
    })) as EvaluatorRevision;
    await app.execute("runs.assess", {
      source: "deterministic",
      name: "Saved answer rules",
      runId: run.run.id,
      evaluatorRevisionId: revision.id,
    });
    const after = (await app.execute("runs.get", {
      runId: run.run.id,
    })) as RunView;
    expect(after.assessmentPasses).toHaveLength(2);
    expect(after.assessmentPasses![1]?.judgments[0]?.status).toBe("correct");
    expect(after.attempts).toEqual(before.attempts);
    expect(after.run.manifest).toEqual(before.run.manifest);
  });
  it("halts active work and resumes unfinished questions with new attempts", async () => {
    let calls = 0;
    const { app, bank } = await setup(
      runtime(async ({ signal }) => {
        calls++;
        if (calls === 1 && !signal.aborted)
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        if (signal.aborted) throw new Error("Interrupted");
        return { answer: 42, text: "42" };
      }),
    );
    const run = (await app.execute("runs.launch", {
      bankRevisionId: bank.id,
      agent,
    })) as RunView;
    await app.execute("runs.control", { runId: run.run.id, action: "halt" });
    await app.waitForIdle();
    expect(
      ((await app.execute("runs.get", { runId: run.run.id })) as RunView).run
        .status,
    ).toBe("halted");
    await app.execute("runs.control", { runId: run.run.id, action: "resume" });
    await app.waitForIdle();
    const view = (await app.execute("runs.get", {
      runId: run.run.id,
    })) as RunView;
    expect(view.run.status).toBe("completed");
    expect(view.attempts.map((a) => a.status)).toEqual([
      "interrupted",
      "completed",
    ]);
  });
  it("uses one researcher conversation and audits explicit gold retrieval", async () => {
    const port = runtime();
    let turns = 0;
    const messages: string[] = [];
    port.researcher = async (input) => {
      turns++;
      messages.push(input.message);
      if (turns === 1) {
        expect(input.conversationId).toBeUndefined();
        input.onEvent({
          type: "conversation.created",
          message: "Conversation ready.",
          data: { conversationId: "provider-conversation" },
        });
        const parsed = JSON.parse(input.message) as {
          baselineRun: { runId: string };
          startingAgent: AgentConfig;
        };
        const evidence = await input.readEvidence({
          runId: parsed.baselineRun.runId,
          includeGold: true,
        });
        expect(JSON.stringify(evidence)).toContain("expected");
        return {
          conversationId: "provider-conversation",
          message: "Try a focused prompt.",
          decision: "keep",
          proposal: {
            ...parsed.startingAgent,
            systemPrompt: "Answer accurately.",
          },
        };
      }
      expect(input.conversationId).toBe("provider-conversation");
      return {
        conversationId: "provider-conversation",
        message: "Done.",
        decision: "stop",
      };
    };
    const { app, bank } = await setup(port);
    const created = await app.execute("research.launch", {
      baseline: { bankRevisionId: bank.id, agent },
      researcher: agent,
      objective: "Improve accuracy.",
      maxCandidates: 1,
    });
    await app.waitForIdle();
    const view = await app.execute("research.get", {
      sessionId: created.session.id,
    });
    expect(view.session.status).toBe("completed");
    expect(view.session.runIds).toHaveLength(2);
    expect(view.session.turns).toHaveLength(2);
    expect(
      view.events.some((event) => event.type === "research.gold.retrieved"),
    ).toBe(true);
    expect(messages[0]).not.toContain("What is the answer?");
    expect(messages[0]).not.toContain("expected");
  });
  it("rejects baseline budgets before invoking a target and rejects replaced conversations", async () => {
    let targetCalls = 0;
    const port = runtime(async () => {
      targetCalls++;
      return { answer: 42, text: "42" };
    });
    port.researcher = async (input) => {
      input.onEvent({
        type: "conversation.created",
        message: "Ready.",
        data: { conversationId: "first" },
      });
      return {
        conversationId: "different",
        message: "Done.",
        decision: "stop",
      };
    };
    const { app, bank } = await setup(port);
    const input = {
      baseline: { bankRevisionId: bank.id, agent, repetitions: 2 },
      researcher: agent,
      objective: "Improve accuracy.",
      maxTargetInvocations: 1,
    };
    await expect(app.execute("research.launch", input)).rejects.toThrow(
      /budget/,
    );
    expect(targetCalls).toBe(0);
    const launched = await app.execute<"research.launch">("research.launch", {
      ...input,
      maxTargetInvocations: 5,
    });
    await app.waitForIdle();
    const view = await app.execute("research.get", {
      sessionId: launched.session.id,
    });
    expect(view.session.status).toBe("failed");
    expect(view.session.conversationId).toBe("first");
    expect(view.session.error).toContain("conversation ID");
  });
});

it("retains safe transient attempts and does not retry a wrong answer", async () => {
  let calls = 0;
  const { app, bank } = await setup(
    runtime(async () => {
      calls++;
      if (calls === 1)
        throw Object.assign(new Error("Provider busy"), {
          code: "target_failure",
          executionFailure: {
            category: "rate-limit",
            transient: true,
            retrySafety: "not-started",
            usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
          },
        });
      return { answer: 41, text: "41" };
    }),
  );
  const run = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
  });
  await app.waitForIdle();
  const view = await app.execute("runs.get", { runId: run.run.id });
  expect(calls).toBe(2);
  expect(view.attempts.map((a) => a.status)).toEqual(["failed", "completed"]);
  expect(view.assessmentPasses![0]?.judgments[0]?.status).toBe("incorrect");
});
it("recovers acknowledged failed slots in the original Run without changing its manifest", async () => {
  let fail = true;
  const { app, bank } = await setup(
    runtime(async () => {
      if (fail)
        throw Object.assign(new Error("Unknown failure"), {
          code: "target_failure",
        });
      return { answer: 42, text: "42" };
    }),
  );
  const original = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
  });
  await app.waitForIdle();
  await expect(
    app.execute("runs.retry-failed", {
      runId: original.run.id,
      idempotencyKey: "retry",
    }),
  ).rejects.toThrow(/duplicate/i);
  fail = false;
  const retry = await app.execute("runs.retry-failed", {
    runId: original.run.id,
    idempotencyKey: "retry",
    acknowledgeDuplicateWork: true,
  });
  await app.waitForIdle();
  expect(retry.run.manifest).toEqual(original.run.manifest);
  expect(retry.run.id).toBe(original.run.id);
  expect(
    (await app.execute("runs.get", { runId: original.run.id })).attempts,
  ).toHaveLength(2);
  expect(
    (await app.execute("runs.get", { runId: retry.run.id })).results[0]?.status,
  ).toBe("completed");
});

it("gives each explicit recovery a bounded transient retry allowance without resetting physical attempt numbers", async () => {
  let calls = 0;
  const { app, bank } = await setup(
    runtime(async () => {
      calls++;
      if (calls <= 2)
        throw Object.assign(new Error("Unknown failure"), {
          code: "target_failure",
        });
      if (calls === 3)
        throw Object.assign(new Error("Provider busy"), {
          code: "target_failure",
          executionFailure: {
            category: "rate-limit",
            transient: true,
            retrySafety: "not-started",
          },
        });
      return { answer: 42, text: "42" };
    }),
  );
  const original = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
  });
  await app.waitForIdle();
  for (const key of ["first-recovery", "second-recovery"]) {
    await app.execute("runs.retry-failed", {
      runId: original.run.id,
      acknowledgeDuplicateWork: true,
      idempotencyKey: key,
    });
    await app.waitForIdle();
  }
  const recovered = await app.execute("runs.get", { runId: original.run.id });
  expect(calls).toBe(4);
  expect(recovered.attempts.map((attempt) => attempt.number)).toEqual([
    1, 2, 3, 4,
  ]);
  expect(recovered.progress.completed).toBe(1);
  expect(recovered.performance).toMatchObject({
    originalFailures: 1,
    recoveredResults: 1,
  });
});

it("caps transient retries at three physical attempts", async () => {
  let calls = 0;
  const { app, bank } = await setup(
    runtime(async () => {
      calls++;
      throw Object.assign(new Error("Busy"), {
        code: "target_failure",
        executionFailure: {
          category: "provider-capacity",
          transient: true,
          retrySafety: "not-started",
        },
      });
    }),
  );
  const run = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
  });
  await app.waitForIdle();
  expect(calls).toBe(3);
  expect(
    (await app.execute("runs.get", { runId: run.run.id })).results[0]?.status,
  ).toBe("failed");
});
it("does not retry after observed tool activity even if a runtime claims safety", async () => {
  let calls = 0;
  const { app, bank } = await setup(
    runtime(async (input) => {
      calls++;
      input.onEvent({ type: "tool.started", message: "Tool admitted" });
      throw Object.assign(new Error("Busy"), {
        code: "target_failure",
        executionFailure: {
          category: "rate-limit",
          transient: true,
          retrySafety: "not-started",
        },
      });
    }),
  );
  const run = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
  });
  await app.waitForIdle();
  expect(calls).toBe(1);
  expect(
    (await app.execute("runs.get", { runId: run.run.id })).attempts[0]?.failure
      ?.classification?.retrySafety,
  ).toBe("unsafe");
});
it("cancels retry waiting without another invocation", async () => {
  let calls = 0;
  const { app, bank } = await setup(
    runtime(async () => {
      calls++;
      throw Object.assign(new Error("Busy"), {
        code: "target_failure",
        executionFailure: {
          category: "rate-limit",
          transient: true,
          retrySafety: "not-started",
          retryAfterMs: 30000,
        },
      });
    }),
  );
  const run = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
  });
  for (let i = 0; i < 100; i++) {
    const history = await app.execute("runs.events", { runId: run.run.id });
    if (history.events.some((event) => event.type === "question.retry.waiting"))
      break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await app.execute("runs.control", { runId: run.run.id, action: "cancel" });
  await app.waitForIdle();
  expect(calls).toBe(1);
  expect(
    (await app.execute("runs.get", { runId: run.run.id })).run.status,
  ).toBe("cancelled");
});

it("applies reduced shared admission to concurrent automatic retries", async () => {
  let calls = 0,
    active = 0,
    peak = 0;
  let release!: () => void;
  const firstPair = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { app, bank } = await setup(
    runtime(async () => {
      const number = ++calls;
      if (number <= 2) {
        if (number === 2) release();
        await firstPair;
        throw Object.assign(new Error("Busy"), {
          code: "target_failure",
          executionFailure: {
            category: "rate-limit",
            transient: true,
            retrySafety: "not-started",
            retryAfterMs: 1000,
          },
        });
      }
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 80));
      active--;
      return { answer: 42, text: "42" };
    }),
  );
  await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
    repetitions: 2,
    limits: { concurrency: 2 },
  });
  await app.waitForIdle();
  expect(calls).toBe(4);
  expect(peak).toBe(1);
});

it("returns Run snapshots without event history while dedicated HTTP and CLI cursors retain every event", async () => {
  const { app, bank, directory } = await setup(
    runtime(async ({ onEvent }) => {
      for (let index = 1; index <= 1001; index++)
        onEvent({ type: "agent.message", message: "trace-" + index });
      return { answer: 42, text: "42" };
    }),
  );
  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
  });
  await app.waitForIdle();
  const server = await startServer({ application: app, port: 0 });
  cleanups.push(() => server.close());
  const { DatabaseSync } = await import("node:sqlite");
  const reader = new DatabaseSync(join(directory, "workspace.sqlite"), {
    readOnly: true,
  });
  const { runCli } = await import("../cli.js");
  try {
    const saved = () =>
      JSON.stringify({
        records: reader
          .prepare("SELECT kind,id,value FROM records ORDER BY ordinal")
          .all(),
        events: reader.prepare("SELECT * FROM events ORDER BY sequence").all(),
      });
    const before = saved();
    const stored = reader
      .prepare(
        "SELECT sequence,message FROM events WHERE run_id=? ORDER BY sequence",
      )
      .all(launched.run.id);
    const eventsSpy = vi.spyOn(Database.prototype, "events");
    try {
      for (const operation of ["runs.get", "runs.observe"] as const) {
        const response = await fetch(
          server.url + "/api/commands/" + operation,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ runId: launched.run.id }),
          },
        );
        expect(response.status).toBe(200);
        const snapshot = await response.json();
        expect(snapshot).not.toHaveProperty("events");
        expect(snapshot).not.toHaveProperty("cursor");
        expect(snapshot.run.id).toBe(launched.run.id);
        expect(snapshot.progress.completed).toBe(1);
        if (operation === "runs.get")
          expect(snapshot.run.manifest).toEqual(launched.run.manifest);
        else expect(snapshot.run).not.toHaveProperty("manifest");
      }
      expect(eventsSpy).not.toHaveBeenCalled();
    } finally {
      eventsSpy.mockRestore();
    }
    for (const operation of ["runs.get", "runs.observe"] as const) {
      const response = await fetch(server.url + "/api/commands/" + operation, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: launched.run.id, cursor: 0 }),
      });
      expect(response.status).toBe(400);
    }
    const cliSnapshot = (await runCli([
      "runs.get",
      "--url",
      server.url,
      "--json",
      JSON.stringify({ runId: launched.run.id }),
    ])) as RunView;
    expect(cliSnapshot).not.toHaveProperty("events");
    expect(cliSnapshot).not.toHaveProperty("cursor");
    expect(cliSnapshot.run.manifest).toEqual(launched.run.manifest);
    const collected: Array<{ sequence: number; message: string }> = [];
    let cursor = 0;
    for (;;) {
      const page = (await runCli([
        "runs.events",
        "--url",
        server.url,
        "--json",
        JSON.stringify({ runId: launched.run.id, cursor }),
      ])) as { events: typeof collected; cursor: number };
      collected.push(
        ...page.events.map(({ sequence, message }) => ({ sequence, message })),
      );
      cursor = page.cursor;
      if (page.events.length < 200) break;
    }
    expect(collected).toEqual(stored);
    expect(collected.some((event) => event.message === "trace-1")).toBe(true);
    expect(collected.some((event) => event.message === "trace-1001")).toBe(
      true,
    );
    expect(saved()).toBe(before);
  } finally {
    reader.close();
  }
});
