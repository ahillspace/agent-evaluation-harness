import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createApplication } from "../../src/application/application.js";
import {
  agentSchema,
  evaluatorSettingsSchema,
  type CommandInput,
  type CommandName,
  type CommandResultMap,
  type RuntimePort,
} from "../../src/contracts.js";
import { startServer } from "../../src/server.js";
import { Database } from "../../src/storage/database.js";
import { targetFixture } from "../fixtures/runtime-targets.js";

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "aeh-assessment-history-"));
  cleanups.push(() =>
    rm(directory, { recursive: true, force: true, maxRetries: 3 }),
  );
  const execute = vi.fn(async () => ({ answer: 42, text: "42" }));
  const runtime: RuntimePort = {
    ...targetFixture,
    recover: async () => ({ recovered: [], errors: [] }),
    close: async () => {},
    resolveAgent: async (agent) => agent,
    execute,
    judge: async () => {
      throw new Error("Unexpected judge call");
    },
    researcher: async () => {
      throw new Error("Unexpected researcher call");
    },
    discover: async () => {
      throw new Error("Unexpected discovery");
    },
    listConnections: async () => [],
    saveConnection: async () => {
      throw new Error("Unused");
    },
    deleteConnection: async () => {},
    testConnection: async () => ({ ok: true, message: "Fixture" }),
  };
  const app = await createApplication({ dataDirectory: directory, runtime });
  const server = await startServer({
    application: app,
    port: 0,
    host: "127.0.0.1",
  });
  cleanups.push(() => server.close());
  const reader = new DatabaseSync(join(directory, "workspace.sqlite"), {
    readOnly: true,
  });
  cleanups.push(() => reader.close());
  const records = (kind?: string) =>
    JSON.stringify(
      reader
        .prepare(
          kind
            ? "SELECT kind,id,value FROM records WHERE kind=? ORDER BY kind,id"
            : "SELECT kind,id,value FROM records ORDER BY kind,id",
        )
        .all(...(kind ? [kind] : [])),
    );
  const state = () =>
    JSON.stringify({
      records: records(),
      events: reader.prepare("SELECT * FROM events ORDER BY sequence").all(),
    });
  async function post<K extends CommandName>(
    operation: K,
    input: CommandInput<K>,
  ): Promise<CommandResultMap[K]> {
    const response = await fetch(`${server.url}/api/commands/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const result = await response.json();
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  }
  return { directory, app, execute, records, state, post };
}

it.each(["evaluators.preview", "banks.preview-draft"] as const)(
  "%s preserves exact first-execution verdicts behind saved generic exclusion metadata",
  async (operation) => {
    const { app, directory, execute, state, post } = await fixture();
    const bank = await post("banks.create", {
      name: "Reference history",
      questions: [{ id: "q1", text: "Count?", expected: 42 }],
    });
    const settings = evaluatorSettingsSchema.parse({
      referenceDisposition: "needs_review",
      referenceNote: "Source scope is disputed",
    });
    const draft = await post("evaluators.draft", {
      bankId: bank.bankId,
      name: "Frozen reference policy",
      settings,
    });
    const evaluator = await post("evaluators.publish", {
      draftId: draft.id,
      activate: true,
    });
    const launch = await post("runs.launch", {
      bankRevisionId: bank.id,
      evaluatorRevisionId: evaluator.id,
      agent: agentSchema.parse({ harness: "codex", model: "fixture" }),
    });
    await app.waitForIdle();
    const saved = await post("runs.export-assessment", {
      runId: launch.run.id,
      passId: `original_deterministic_${launch.run.id}`,
    });
    expect(saved.judgments[0]).toMatchObject({
      status: "excluded",
      explanation: "Excluded by the selected reference policy.",
    });
    expect(saved.judgments[0]).not.toHaveProperty("details");
    const identical = await post("evaluators.draft", {
      bankId: bank.bankId,
      name: "Identical reference policy",
      settings,
    });
    const before = state();
    const preview =
      operation === "evaluators.preview"
        ? await post(operation, {
            draftId: identical.id,
            runIds: [launch.run.id],
          })
        : await post(operation, {
            bankId: bank.bankId,
            questions: bank.questions,
            settings,
            runIds: [launch.run.id],
          });
    const expected = {
      status: "unscorable",
      explanation: "Source scope is disputed",
      details: { reason: "reference_review", path: "" },
    };
    expect(preview.runs[0]!.rows[0]).toMatchObject({
      before: expected,
      after: expected,
      changed: false,
    });
    expect(preview.runs[0]!.changes).toHaveLength(0);
    expect(state()).toBe(before);
    expect(
      await post("runs.export-assessment", {
        runId: launch.run.id,
        passId: saved.id,
      }),
    ).toEqual(saved);
    const changedSettings = {
      ...settings,
      referenceNote: "Reference scope changed",
    };
    const changedDraft = await post("evaluators.draft", {
      bankId: bank.bankId,
      name: "Changed note",
      settings: changedSettings,
    });
    const changed =
      operation === "evaluators.preview"
        ? await post(operation, {
            draftId: changedDraft.id,
            runIds: [launch.run.id],
          })
        : await post(operation, {
            bankId: bank.bankId,
            questions: bank.questions,
            settings: changedSettings,
            runIds: [launch.run.id],
          });
    expect(changed.runs[0]!.rows[0]).toMatchObject({
      before: expected,
      after: { status: "unscorable", explanation: "Reference scope changed" },
      changed: true,
    });
    expect(changed.runs[0]!.changes).toHaveLength(1);
    const correct = await post("banks.check-answer", {
      question: bank.questions[0]!,
      answer: 42,
      settings: evaluatorSettingsSchema.parse({}),
    });
    expect(correct.status).toBe("correct");
    // Historical raw grading must not override an incompatible captured status.
    const db = new Database(join(directory, "workspace.sqlite"));
    db.insert(
      "scoreSet",
      {
        id: "inconsistent-original-status",
        runId: launch.run.id,
        evaluator,
        createdAt: launch.run.createdAt,
        kind: "original",
        published: true,
        assessments: db
          .list("assessment", { runId: launch.run.id })
          .map((assessment) => ({ ...assessment, deterministic: correct })),
      },
      true,
    );
    db.close();
    const restoredSettings = evaluatorSettingsSchema.parse({});
    const restoredDraft = await post("evaluators.draft", {
      bankId: bank.bankId,
      name: "Restore grading",
      settings: restoredSettings,
    });
    const beforeMismatchPreview = state();
    const mismatch =
      operation === "evaluators.preview"
        ? await post(operation, {
            draftId: restoredDraft.id,
            runIds: [launch.run.id],
          })
        : await post(operation, {
            bankId: bank.bankId,
            questions: bank.questions,
            settings: restoredSettings,
            runIds: [launch.run.id],
          });
    expect(mismatch.runs[0]!.rows[0]!.before).toBeUndefined();
    expect(mismatch.runs[0]!.rows[0]).toMatchObject({
      after: correct,
      changed: true,
    });
    expect(mismatch.runs[0]!.changes).toHaveLength(1);
    expect(state()).toBe(beforeMismatchPreview);
    expect(execute).toHaveBeenCalledTimes(1);
  },
);

it.each(["empty", "note"] as const)(
  "reviewing an unpublished historical draft with %s overrides preserves comparison eligibility",
  async (kind) => {
    const { app, directory, execute, records, state, post } = await fixture();
    const bank = await post("banks.create", {
      name: "Draft history",
      questions: [{ id: "q1", text: "Count?", expected: 42 }],
    });
    const agent = agentSchema.parse({ harness: "codex", model: "fixture" });
    const first = await post("runs.launch", { bankRevisionId: bank.id, agent });
    const second = await post("runs.launch", {
      bankRevisionId: bank.id,
      agent,
    });
    await app.waitForIdle();
    const db = new Database(join(directory, "workspace.sqlite"));
    const evaluator = first.run.manifest.evaluator,
      savedAt = Date.now();
    db.insert(
      "scoreSet",
      {
        id: "published-history",
        runId: first.run.id,
        evaluator,
        createdAt: new Date(savedAt + 1000).toISOString(),
        kind: "rescore",
        published: true,
        assessments: db.list("assessment", { runId: first.run.id }),
      },
      true,
    );
    db.insert("scoreSet", {
      id: "unpublished-history",
      runId: first.run.id,
      evaluator,
      createdAt: new Date(savedAt + 2000).toISOString(),
      kind: "rescore",
      published: false,
      assessments: [],
    });
    db.close();
    const historicalBytes = records("scoreSet");
    const comparisonInput = {
      runIds: [first.run.id, second.run.id],
      evaluatorRevisionId: evaluator.id,
    };
    const before = await post("runs.compare", comparisonInput);
    expect(before.rows[0]).toMatchObject({
      assessmentPassId: "scores_published-history",
      accuracy: 1,
      graded: 1,
    });
    const draft = await post("runs.assessment", {
      runId: first.run.id,
      passId: "scores_unpublished-history",
    });
    const review = await post("runs.review-assessment", {
      runId: first.run.id,
      parentPassId: draft.id,
      name: "Read-only draft review",
      overrides:
        kind === "empty"
          ? []
          : [
              {
                resultId: first.results[0]!.id,
                verdict: null,
                note: "Historical context",
              },
            ],
    });
    const readState = state();
    const after = await post("runs.compare", comparisonInput);
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(state()).toBe(readState);
    expect(review.parentPassId).toBe(draft.id);
    expect(records("scoreSet")).toBe(historicalBytes);
    const defaultView = await post("runs.get", { runId: second.run.id });
    expect(defaultView.selectedAssessmentPassId).toBe(
      `original_deterministic_${second.run.id}`,
    );
    expect(execute).toHaveBeenCalledTimes(2);
  },
);
