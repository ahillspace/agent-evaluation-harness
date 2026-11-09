import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  agentSchema,
  type CommandInput,
  type CommandName,
  type CommandResultMap,
  type RuntimePort,
} from "../contracts.js";
import { startServer } from "../server.js";
import { targetFixture } from "../../tests/fixtures/runtime-targets.js";
import { createApplication } from "./application.js";

it.each(["evaluators.preview", "banks.preview-draft"] as const)(
  "%s grades one captured score and answer basis when another Run finishes recovery during preview",
  async (operation) => {
    const directory = await mkdtemp(join(tmpdir(), "aeh-preview-snapshot-"));
    let release!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const recoveryEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let recoveryCalls = 0;
    const runtime: RuntimePort = {
      ...targetFixture,
      resolveAgent: async (agent) => agent,
      recover: async () => ({ recovered: [], errors: [] }),
      close: async () => {},
      discover: async () => ({
        harnesses: [],
        connectionProviders: [],
        maxConcurrency: 1,
      }),
      listConnections: async () => [],
      saveConnection: async () => {
        throw new Error("Unused");
      },
      deleteConnection: async () => {},
      testConnection: async () => ({ ok: true, message: "Fixture" }),
      execute: async (input) => {
        if (input.question.id === "recover") {
          if (++recoveryCalls === 1)
            throw Object.assign(new Error("Fixture first failure"), {
              code: "target_failure",
            });
          entered();
          await recoveryGate;
        }
        return { answer: 42, text: "42" };
      },
      judge: async () => {
        throw new Error("Unexpected judge");
      },
      researcher: async () => {
        throw new Error("Unexpected researcher");
      },
    };
    const app = await createApplication({ dataDirectory: directory, runtime });
    const server = await startServer({
      application: app,
      port: 0,
      host: "127.0.0.1",
    });
    async function command<K extends CommandName>(
      name: K,
      input: CommandInput<K>,
    ): Promise<CommandResultMap[K]> {
      const response = await fetch(`${server.url}/api/commands/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      return body as CommandResultMap[K];
    }
    const immediate = globalThis.setImmediate;
    let interleaved = false;
    let interleavingError: unknown;
    let immediateSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const bank = await command("banks.create", {
        name: "Preview snapshot",
        questions: ["stable", "recover"].map((id) => ({
          id,
          text: `${id}?`,
          expected: 42,
        })),
      });
      const agent = agentSchema.parse({ harness: "codex", model: "fixture" });
      const first = await command("runs.launch", {
        bankRevisionId: bank.id,
        questionIds: ["stable"],
        agent,
      });
      await app.waitForIdle();
      const second = await command("runs.launch", {
        bankRevisionId: bank.id,
        agent,
      });
      await app.waitForIdle();
      const settings = second.run.manifest.evaluator.settings;
      const draft = await command("evaluators.draft", {
        bankId: bank.bankId,
        name: "Unchanged rules",
        settings,
      });
      const runIds = [first.run.id, second.run.id];
      const preview = () =>
        operation === "evaluators.preview"
          ? command(operation, { draftId: draft.id, runIds })
          : command(operation, {
              bankId: bank.bankId,
              questions: bank.questions,
              settings,
              runIds,
            });
      await command("runs.retry-failed", {
        runId: second.run.id,
        acknowledgeDuplicateWork: true,
        idempotencyKey: "held-recovery",
      });
      await recoveryEntered;
      const before = await command("runs.observe", { runId: second.run.id });
      const original = before.assessmentPasses!.find((pass) =>
        pass.id.startsWith("original_deterministic_"),
      )!;
      const current = before.assessmentPasses!.find(
        (pass) => pass.id === before.selectedAssessmentPassId,
      )!;
      expect(current.coverage).toMatchObject({
        answered: 1,
        correct: 1,
        unjudged: 1,
      });
      immediateSpy = vi
        .spyOn(globalThis, "setImmediate")
        .mockImplementation((callback, ...args) => {
          if (!interleaved && new Error().stack?.includes("evaluations.ts")) {
            interleaved = true;
            release();
            const settled = app.waitForIdle();
            return immediate(() => {
              void settled
                .catch((error: unknown) => {
                  interleavingError = error;
                })
                .then(() => callback(...args));
            });
          }
          return immediate(callback, ...args);
        });
      const racing = await preview();
      immediateSpy.mockRestore();
      immediateSpy = undefined;
      expect(interleaved).toBe(true);
      expect(interleavingError).toBeUndefined();
      const captured = racing.runs.find((run) => run.runId === second.run.id)!;
      expect(captured.changes).toEqual([]);
      expect(captured.rows.map((row) => row.questionId)).toEqual(["stable"]);
      const refreshed = (await preview()).runs.find(
        (run) => run.runId === second.run.id,
      )!;
      expect(refreshed.changes).toEqual([]);
      expect(refreshed.rows.map((row) => row.questionId)).toEqual([
        "stable",
        "recover",
      ]);
      const after = await command("runs.observe", { runId: second.run.id });
      expect(
        after.assessmentPasses!.find((pass) => pass.id === original.id),
      ).toEqual(original);
      expect(
        after.assessmentPasses!.find((pass) => pass.id === current.id)
          ?.coverage,
      ).toMatchObject({ answered: 2, correct: 2 });
    } finally {
      immediateSpy?.mockRestore();
      release();
      await server.close();
      await app.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  },
);

it.each(["latest", "explicit", "proposed"] as const)(
  "retains the %s calibration reference when publication finishes between grading steps without persisting preview records",
  async (reference) => {
    const directory = await mkdtemp(join(tmpdir(), "aeh-preview-reference-"));
    const runtime: RuntimePort = {
      ...targetFixture,
      resolveAgent: async (agent) => agent,
      recover: async () => ({ recovered: [], errors: [] }),
      close: async () => {},
      discover: async () => ({
        harnesses: [],
        connectionProviders: [],
        maxConcurrency: 1,
      }),
      listConnections: async () => [],
      saveConnection: async () => {
        throw new Error("Unused");
      },
      deleteConnection: async () => {},
      testConnection: async () => ({ ok: true, message: "Fixture" }),
      execute: async () => ({ answer: 42, text: "42" }),
      judge: async () => {
        throw new Error("Unexpected judge");
      },
      researcher: async () => {
        throw new Error("Unexpected researcher");
      },
    };
    const app = await createApplication({ dataDirectory: directory, runtime });
    const server = await startServer({
      application: app,
      port: 0,
      host: "127.0.0.1",
    });
    const reader = new DatabaseSync(join(directory, "workspace.sqlite"));
    async function command<K extends CommandName>(
      name: K,
      input: CommandInput<K>,
    ): Promise<CommandResultMap[K]> {
      const response = await fetch(`${server.url}/api/commands/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      return body as CommandResultMap[K];
    }
    const persisted = () =>
      JSON.stringify({
        records: reader
          .prepare("SELECT kind,id,value FROM records ORDER BY kind,id")
          .all(),
        events: reader.prepare("SELECT * FROM events ORDER BY sequence").all(),
      });
    let immediateSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const bank = await command("banks.create", {
        name: "Calibration capture",
        questions: [{ id: "q", text: "Count?", expected: 42 }],
      });
      const launched = await command("runs.launch", {
        bankRevisionId: bank.id,
        agent: agentSchema.parse({ harness: "codex", model: "fixture" }),
      });
      await app.waitForIdle();
      const settings = {
        ...launched.run.manifest.evaluator.settings,
        calibrationExamples: [
          {
            id: "known-answer",
            questionId: "q",
            answer: 42,
            expectedStatus: "correct" as const,
          },
        ],
      };
      const draft = await command("evaluators.draft", {
        bankId: bank.bankId,
        name: "Unchanged rules",
        settings,
      });
      const preview = () =>
        reference === "proposed"
          ? command("banks.preview-draft", {
              bankId: bank.bankId,
              questions: bank.questions,
              settings,
              runIds: [launched.run.id],
            })
          : command("evaluators.preview", {
              draftId: draft.id,
              runIds: [launched.run.id],
              ...(reference === "explicit" ? { bankRevisionId: bank.id } : {}),
            });
      const immediate = globalThis.setImmediate;
      let interleaved = false;
      let interleavingError: unknown;
      let afterPublication = "";
      let publishedId = "";
      immediateSpy = vi
        .spyOn(globalThis, "setImmediate")
        .mockImplementation((callback, ...args) => {
          if (!interleaved && new Error().stack?.includes("evaluations.ts")) {
            interleaved = true;
            const publication = command("banks.publish", {
              bankId: bank.bankId,
              baseRevisionId: bank.id,
              baseEvaluatorRevisionId: launched.run.manifest.evaluator.id,
              name: bank.name,
              questions: [{ id: "q", text: "Count?", expected: 43 }],
              evaluatorName: "Next standard",
              evaluatorSettings: { ...settings, calibrationExamples: [] },
            });
            return immediate(() => {
              void publication
                .then((published) => {
                  publishedId = published.revision.id;
                  afterPublication = persisted();
                })
                .catch((error: unknown) => {
                  interleavingError = error;
                })
                .then(() => callback(...args));
            });
          }
          return immediate(callback, ...args);
        });
      const captured = await preview();
      immediateSpy.mockRestore();
      immediateSpy = undefined;
      expect(interleaved).toBe(true);
      expect(interleavingError).toBeUndefined();
      expect(persisted()).toBe(afterPublication);
      expect(captured.runs[0]!.changes).toEqual([]);
      expect(captured.calibration!.bankRevisionId).toBe(
        reference === "proposed" ? captured.referenceBank!.id : bank.id,
      );
      expect(captured.calibration).toMatchObject({
        total: 1,
        passed: 1,
        results: [{ actual: { status: "correct" } }],
      });
      const next = await preview();
      expect(next.calibration!.passed).toBe(reference === "latest" ? 0 : 1);
      expect(next.calibration!.bankRevisionId).toBe(
        reference === "latest"
          ? publishedId
          : captured.calibration!.bankRevisionId,
      );
      expect(persisted()).toBe(afterPublication);
    } finally {
      immediateSpy?.mockRestore();
      reader.close();
      await server.close();
      await app.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  },
);
