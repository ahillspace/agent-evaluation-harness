import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createApplication } from "../../src/application/application.js";
import {
  attemptBudgetResearchSessionId,
  checkResearchBudget,
} from "../../src/application/research-budget.js";
import {
  agentSchema,
  jevProfileSettingsSchema,
  type CommandInput,
  type CommandName,
  type CommandResultMap,
  type RuntimePort,
} from "../../src/contracts.js";
import { Database } from "../../src/storage/database.js";
import { startServer } from "../../src/server.js";
import { targetFixture } from "../fixtures/runtime-targets.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const agent = agentSchema.parse({ harness: "codex", model: "fixture" });

async function fixture(continuation: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "aeh-manual-research-"));
  cleanups.push(() =>
    rm(directory, { recursive: true, force: true, maxRetries: 3 }),
  );
  let manual = false;
  let entered!: () => void;
  const interrupted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const calls: Array<{ kind: string; attemptId: string; timeoutMs: number }> =
    [];
  let researcherCalls = 0;
  const usage = { inputTokens: 10, outputTokens: 1, costUsd: 0.01 };
  const runtime: RuntimePort = {
    ...targetFixture,
    resolveAgent: async (value) => value,
    recover: async () => ({ recovered: [], errors: [] }),
    close: async () => {},
    discover: async () => {
      throw new Error("Unexpected discovery");
    },
    listConnections: async () => [],
    deleteConnection: async () => {},
    saveConnection: async () => {
      throw new Error("Unused");
    },
    testConnection: async () => ({ ok: true, message: "Fixture" }),
    execute: async (input) => {
      calls.push({
        kind: "target",
        attemptId: input.attemptId,
        timeoutMs: input.timeoutMs,
      });
      if (!manual && input.question.id === "failed") {
        if (continuation) await interrupted;
        throw Object.assign(new Error("Fixture execution failure"), {
          code: "target_failure",
          executionFailure: {
            category: continuation ? "configuration" : "tool",
            transient: false,
            retrySafety: "unknown",
            usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
          },
        });
      }
      if (!manual && input.question.id === "interrupted") {
        entered();
        await new Promise<void>((resolve) => {
          input.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
          if (input.signal.aborted) resolve();
        });
        throw new Error("Interrupted fixture attempt");
      }
      const answer = input.question.id === "incorrect" ? 41 : 42;
      return { answer, text: String(answer), usage };
    },
    judge: async (input) => {
      calls.push({
        kind: "llm",
        attemptId: input.evidence.attemptId,
        timeoutMs: input.timeoutMs,
      });
      return {
        verdict: input.evidence.finalAnswer === 42,
        explanation: "Fixture judgment",
        usage,
      };
    },
    classifier: {
      resolveConnection: async (connectionId) => ({
        connectionId,
        provider: "typesafe",
        settings: {},
        credentialFields: [],
      }),
      evaluate: async (input) => {
        calls.push({
          kind: "jev",
          attemptId: input.evidence.attemptId,
          timeoutMs: input.timeoutMs,
        });
        const request = { fixture: input.evidence.attemptId };
        input.onRequest(request);
        const choice =
          input.evidence.finalAnswer === 42 ? "acceptable" : "incorrect";
        return {
          request,
          response: { fixture: true },
          model: "jev-1.13.0",
          checks: {
            answer: {
              choice,
              probabilities: { [choice]: 0.9 },
              confidence: 0.9,
            },
          },
          usage,
        };
      },
    },
    researcher: async () => {
      researcherCalls++;
      return {
        conversationId: "research-conversation",
        message: "Finished",
        control: "stop",
      };
    },
  };
  const app = await createApplication({ dataDirectory: directory, runtime });
  cleanups.push(() => app.close());
  const server = await startServer({
    application: app,
    port: 0,
    host: "127.0.0.1",
  });
  cleanups.push(() => server.close());
  async function post<K extends CommandName>(
    operation: K,
    input: CommandInput<K>,
  ): Promise<CommandResultMap[K]> {
    const response = await fetch(`${server.url}/api/commands/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const body: unknown = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body as CommandResultMap[K];
  }
  async function rejected(operation: CommandName, input: unknown) {
    const response = await fetch(`${server.url}/api/commands/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  }
  const ids = continuation
    ? ["incorrect", "failed", "interrupted", "pending"]
    : ["incorrect", "failed", "correct"];
  const bank = await post("banks.create", {
    name: "Terminal research",
    questions: ids.map((id) => ({ id, text: id, expected: 42 })),
  });
  await post("jev.profiles.publish", {
    bankId: bank.bankId,
    name: "Fixture judge",
    settings: jevProfileSettingsSchema.parse({ evidenceRequirement: "answer" }),
  });
  const launch = await post("research.launch", {
    name: "Bounded original research",
    baseline: {
      bankRevisionId: bank.id,
      agent,
      limits: { concurrency: continuation ? 2 : 1, timeoutMs: 2500 },
      judge: { enabled: true, agent, evidenceRequirement: "answer" },
      jevJudge: { connectionId: "fixture" },
    },
    researcher: agent,
    objective: "Accuracy",
    maxCandidates: 1,
    maxTargetInvocations: ids.length,
    maxDurationMs: 1000,
  });
  await app.waitForIdle();
  const runId = launch.session.baselineRunId;
  const sessionId = launch.session.id;
  const view = await post("runs.get", { runId });
  await post("runs.review-assessment", {
    runId,
    parentPassId: view.assessmentPasses!.find(
      (pass) => pass.source === "deterministic",
    )!.id,
    name: "Saved original review",
    overrides: [
      {
        resultId: view.results.find((result) => result.questionId === "failed")!
          .id,
        verdict: null,
        note: "Preserve the original failure.",
      },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const snapshot = () => {
    const db = new Database(join(directory, "workspace.sqlite"));
    try {
      const session = db.require("research", sessionId);
      const attempts = db
        .list("attempt", { runId })
        .filter(
          (attempt) =>
            attemptBudgetResearchSessionId(db, attempt) === sessionId,
        );
      return {
        session,
        attempts,
        llmUsage: db.originalJudgeUsage(
          runId,
          attempts.map((attempt) => attempt.id),
        ),
        jev: db
          .list("jevAssessment", { runId })
          .filter((record) =>
            attempts.some((attempt) => attempt.id === record.attemptId),
          ),
        budget: checkResearchBudget(db, session, 1),
      };
    } finally {
      db.close();
    }
  };
  const before = await post("runs.get", { runId });
  const passes = await Promise.all(
    before.assessmentPasses!.map((pass) =>
      post("runs.export-assessment", { runId, passId: pass.id }),
    ),
  );
  return {
    app,
    runtime,
    post,
    rejected,
    calls,
    runId,
    sessionId,
    before,
    passes,
    snapshot,
    researcherCalls: () => researcherCalls,
    admit: () => {
      manual = true;
    },
  };
}

it.each([false, true])(
  "uses normal Run limits for manual terminal-Research recovery, continuation=%s",
  async (continuation) => {
    const f = await fixture(continuation);
    const original = f.snapshot();
    expect(original.session.status).toBe(continuation ? "failed" : "completed");
    expect(original.budget).toMatch(/duration/);
    const priorCalls = f.calls.length;
    const priorResearcherCalls = f.researcherCalls();
    const scope = f.before.run.execution!;
    expect(f.before.controllingJob?.kind).toBe("run");
    if (continuation) {
      expect(scope.settledAt).toBeUndefined();
      expect(f.before.allowedActions).toContain("resume");
    }
    f.admit();
    const key = "manual-normal-limits";
    const request = continuation
      ? () =>
          f.post("runs.control", {
            runId: f.runId,
            action: "resume",
            idempotencyKey: key,
            expectedExecutionId: scope.id,
            acknowledgeDuplicateWork: true,
          })
      : () =>
          f.post("runs.retry-failed", {
            runId: f.runId,
            idempotencyKey: key,
            expectedExecutionId: scope.id,
            acknowledgeDuplicateWork: true,
          });
    expect((await request()).run.id).toBe(f.runId);
    await f.app.waitForIdle();
    const after = await f.post("runs.get", { runId: f.runId });
    expect(after.run.researchSessionId).toBe(f.sessionId);
    expect(after.run.manifest).toEqual(f.before.run.manifest);
    expect(after.run.execution?.id).not.toBe(scope.id);
    expect(after.run.execution?.controller).toBe("run");
    expect(after.run.execution?.budgetResearchSessionId).toBeUndefined();
    const newer = after.attempts.filter(
      (attempt) => !f.before.attempts.some((old) => old.id === attempt.id),
    );
    expect(newer).toHaveLength(continuation ? 2 : 1);
    for (const attempt of newer) {
      expect(attempt.executionId).toBe(after.run.execution!.id);
      expect(attempt.budgetResearchSessionId).toBeUndefined();
    }
    expect(f.calls.slice(priorCalls).map((call) => call.timeoutMs)).toEqual(
      Array((continuation ? 2 : 1) * 3).fill(2500),
    );
    expect(
      after.results.find((result) => result.questionId === "incorrect"),
    ).toEqual(
      f.before.results.find((result) => result.questionId === "incorrect"),
    );
    if (continuation)
      expect(
        after.results.find((result) => result.questionId === "failed")!.status,
      ).toBe("failed");
    for (const pass of f.passes)
      expect(
        await f.post("runs.export-assessment", {
          runId: f.runId,
          passId: pass.id,
        }),
      ).toEqual(pass);
    expect(f.snapshot()).toEqual(original);
    expect(f.researcherCalls()).toBe(priorResearcherCalls);
    expect(after.performance!.attempts).toBe(
      f.before.performance!.attempts + newer.length,
    );
    expect(after.performance!.judge.calls).toBe(
      f.before.performance!.judge.calls + newer.length * 2,
    );
    const calls = f.calls.length;
    expect((await request()).run.execution?.id).toBe(after.run.execution!.id);
    expect(f.calls).toHaveLength(calls);
  },
);

it.each([false, true])(
  "waits for saved judge work before terminal-Research manual admission, continuation=%s",
  async (continuation) => {
    const f = await fixture(continuation);
    const evaluate = f.runtime.classifier!.evaluate;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.runtime.classifier!.evaluate = async (input) => {
      entered();
      await gate;
      return evaluate(input);
    };
    const targets = f.calls.filter((call) => call.kind === "target").length;
    cleanups.push(async () => release());
    const assessment = f.post("runs.assess", {
      runId: f.runId,
      source: "jev",
      name: "Outstanding saved judge",
    });
    try {
      await started;
      const view = await f.post("runs.get", { runId: f.runId });
      expect(
        continuation
          ? view.resumeEligibility!.available
          : view.retryEligibility!.available,
      ).toBe(false);
      const response = continuation
        ? await f.rejected("runs.control", {
            runId: f.runId,
            action: "resume",
            acknowledgeDuplicateWork: true,
            idempotencyKey: "wait-for-judges",
          })
        : await f.rejected("runs.retry-failed", {
            runId: f.runId,
            acknowledgeDuplicateWork: true,
            idempotencyKey: "wait-for-judges",
          });
      expect(response.status).toBe(409);
      expect(f.calls.filter((call) => call.kind === "target")).toHaveLength(
        targets,
      );
    } finally {
      release();
    }
    await assessment;
    await f.app.waitForIdle();
  },
);

it("keeps a cancelled Run terminal after its historical Research parent ends", async () => {
  const f = await fixture(true);
  const original = f.snapshot();
  await f.post("runs.control", { runId: f.runId, action: "cancel" });
  const calls = f.calls.length;
  for (const operation of ["runs.retry-failed", "runs.control"] as const) {
    const result = await f.rejected(operation, {
      runId: f.runId,
      ...(operation === "runs.control" ? { action: "resume" } : {}),
      idempotencyKey: `cancelled-${operation}`,
      acknowledgeDuplicateWork: true,
    });
    expect(result.status).toBe(409);
  }
  const cancelled = await f.post("runs.get", { runId: f.runId });
  expect(cancelled.run.status).toBe("cancelled");
  expect(cancelled.allowedActions).toEqual([]);
  expect(f.calls).toHaveLength(calls);
  expect(f.snapshot()).toEqual(original);
});
