import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  agentSchema,
  jevProfileSettingsSchema,
  type RuntimePort,
} from "../contracts.js";
import { targetFixture } from "../../tests/fixtures/runtime-targets.js";
import { createApplication } from "./application.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(
  options: {
    failedRetry?: boolean;
    abstainOnRetry?: boolean;
    repetitions?: number;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "aeh-apply-retry-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  let fail = true;
  const calls = { target: 0, llm: 0, jev: 0 };
  const agent = agentSchema.parse({ harness: "codex", model: "fixture" });
  const runtime: RuntimePort = {
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
      throw Error("Unused");
    },
    deleteConnection: async () => {},
    testConnection: async () => ({ ok: true, message: "Fixture" }),
    execute: async (input) => {
      calls.target++;
      if (fail && input.question.id === "retry")
        throw Object.assign(Error("Fixture tool failure"), {
          code: "target_failure",
        });
      return {
        answer: 42,
        text: "42",
        usage: { inputTokens: 10, outputTokens: 1 },
      };
    },
    judge: async () => {
      calls.llm++;
      return {
        verdict: options.abstainOnRetry && !fail ? null : true,
        explanation: "Equivalent answer.",
        usage: { inputTokens: 5, outputTokens: 1 },
      };
    },
    researcher: async () => {
      throw Error("Unused");
    },
    classifier: {
      resolveConnection: async (connectionId) => ({
        connectionId,
        provider: "typesafe",
        settings: {},
        credentialFields: ["apiKey"],
      }),
      evaluate: async (input) => {
        calls.jev++;
        const request = { fixture: true };
        input.onRequest(request);
        return {
          request,
          response: {},
          model: "fixture",
          checks: {
            answer: {
              choice: "acceptable",
              probabilities: {
                acceptable: 1,
                incorrect: 0,
                insufficient_evidence: 0,
              },
              confidence: 1,
            },
          },
          usage: { inputTokens: 5, outputTokens: 1 },
        };
      },
    },
  };
  const app = await createApplication({ dataDirectory: directory, runtime });
  cleanups.push(() => app.close());
  const bank = await app.execute("banks.create", {
    name: "Retry bank",
    questions: [
      { id: "ok", text: "Answer", expected: 42 },
      { id: "retry", text: "Answer again", expected: 42 },
    ],
  });
  await app.execute("jev.profiles.publish", {
    bankId: bank.bankId,
    name: "Answer judge",
    settings: jevProfileSettingsSchema.parse({ evidenceRequirement: "answer" }),
  });
  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
    repetitions: options.repetitions ?? 1,
    judge: { enabled: true, agent, evidenceRequirement: "answer" },
    jevJudge: { connectionId: "fixture" },
  });
  await app.waitForIdle();
  const original = await app.execute("runs.get", { runId: launched.run.id });
  fail = options.failedRetry ?? false;
  const retry = await app.execute("runs.retry-failed", {
    runId: original.run.id,
    acknowledgeDuplicateWork: true,
    idempotencyKey: "fixture-retry",
  });
  await app.waitForIdle();
  return {
    app,
    original,
    retry: await app.execute("runs.get", { runId: retry.run.id }),
    calls,
    agent,
    bank,
  };
}

it("applies a linked successful retry and saved judges without replay, while preserving original evidence and scores", async () => {
  const { app, original, retry, calls } = await setup();
  const failed = original.results.find(
    (result) => result.questionId === "retry",
  )!;
  const completed = retry.results[0]!;
  const originalPasses = await Promise.all(
    original.assessmentPasses!.map((pass) =>
      app.execute("runs.assessment", {
        runId: original.run.id,
        passId: pass.id,
      }),
    ),
  );
  const beforeCalls = { ...calls };
  const applied = await app.execute("runs.apply-retry", {
    runId: original.run.id,
    retryRunId: retry.run.id,
    idempotencyKey: "apply",
  });
  expect(applied.appliedResultIds).toEqual([failed.id]);
  expect(applied.assessmentPassIds).toHaveLength(3);
  expect(calls).toEqual(beforeCalls);
  const view = await app.execute("runs.get", { runId: original.run.id });
  expect(view.progress).toEqual({ completed: 2, failed: 0, total: 2 });
  const recovered = view.results.find((result) => result.id === failed.id)!;
  expect(recovered).toMatchObject({
    status: "failed",
    attemptIds: failed.attemptIds,
    answerSource: {
      runId: retry.run.id,
      resultId: completed.id,
      attemptId: completed.completedAttemptId,
      applicationId: applied.applicationId,
    },
  });
  expect(view.run.manifest).toEqual(original.run.manifest);
  expect(
    view.attempts.filter((attempt) => attempt.id === failed.attemptIds[0]),
  ).toEqual(
    original.attempts.filter((attempt) => attempt.id === failed.attemptIds[0]),
  );
  for (const pass of originalPasses) {
    const saved = await app.execute("runs.assessment", {
      runId: original.run.id,
      passId: pass.id,
    });
    expect(saved.judgments).toEqual(pass.judgments);
  }
  for (const passId of applied.assessmentPassIds) {
    const pass = await app.execute("runs.assessment", {
      runId: original.run.id,
      passId,
    });
    expect(pass.coverage).toMatchObject({ answered: 2, correct: 2, judged: 2 });
    expect(
      pass.judgments.find((judgment) => judgment.resultId === failed.id),
    ).toMatchObject({
      attemptId: completed.completedAttemptId,
      status: "correct",
    });
  }
});

it("makes applied answers available to rescoring, human review, exports, and idempotent application", async () => {
  const { app, original, retry, calls } = await setup();
  const request = {
    runId: original.run.id,
    retryRunId: retry.run.id,
    idempotencyKey: "apply",
  };
  const applied = await app.execute<"runs.apply-retry">(
    "runs.apply-retry",
    request,
  );
  const duplicated = await app.execute<"runs.apply-retry">(
    "runs.apply-retry",
    request,
  );
  expect(duplicated.applicationId).toBe(applied.applicationId);
  const pass = await app.execute("runs.assess", {
    runId: original.run.id,
    name: "Recovered deterministic",
    source: "deterministic",
  });
  expect(pass.coverage).toMatchObject({ answered: 2, correct: 2, judged: 2 });
  const resultId = original.results.find(
    (result) => result.questionId === "retry",
  )!.id;
  const human = await app.execute("runs.review-assessment", {
    runId: original.run.id,
    parentPassId: pass.id,
    name: "Reviewed recovery",
    overrides: [{ resultId, verdict: false, note: "Fixture review" }],
  });
  expect(human.coverage).toMatchObject({
    answered: 2,
    judged: 2,
    reviewed: 1,
    correct: 1,
  });
  const exported = await app.execute("runs.export-assessment", {
    runId: original.run.id,
    passId: human.id,
  });
  expect(exported.judgments).toEqual(human.judgments);
  expect(calls).toEqual({ target: 3, llm: 2, jev: 2 });
});

it("rejects an unrelated successful run without changing the original", async () => {
  const { app, original, agent, bank } = await setup();
  const unrelated = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
  });
  await app.waitForIdle();
  await expect(
    app.execute("runs.apply-retry", {
      runId: original.run.id,
      retryRunId: unrelated.run.id,
      idempotencyKey: "unrelated",
    }),
  ).rejects.toThrow();
  expect(
    (await app.execute("runs.get", { runId: original.run.id })).progress,
  ).toEqual(original.progress);
});

it("preserves prior human decisions and selects the recovered human score", async () => {
  const { app, original, retry, calls } = await setup();
  const ok = original.results.find((result) => result.questionId === "ok")!;
  const failed = original.results.find(
    (result) => result.questionId === "retry",
  )!;
  const deterministic = original.assessmentPasses!.find(
    (pass) => pass.source === "deterministic",
  )!;
  const human = await app.execute("runs.review-assessment", {
    runId: original.run.id,
    parentPassId: deterministic.id,
    name: "Existing review",
    overrides: [
      {
        resultId: ok.id,
        verdict: false,
        note: "Preserve this independent review.",
      },
    ],
  });
  await app.execute("runs.select-assessment", {
    runId: original.run.id,
    passId: human.id,
  });
  const beforeCalls = { ...calls };
  const applied = await app.execute("runs.apply-retry", {
    runId: original.run.id,
    retryRunId: retry.run.id,
    idempotencyKey: "human-apply",
  });
  const view = await app.execute("runs.get", { runId: original.run.id });
  expect(applied.assessmentPassIds).toContain(view.selectedAssessmentPassId);
  const selected = await app.execute("runs.assessment", {
    runId: original.run.id,
    passId: view.selectedAssessmentPassId!,
  });
  expect(selected.source).toBe("human");
  expect(
    selected.judgments.find((judgment) => judgment.resultId === ok.id),
  ).toEqual(human.judgments.find((judgment) => judgment.resultId === ok.id));
  expect(
    selected.judgments.find((judgment) => judgment.resultId === failed.id),
  ).toMatchObject({
    status: "correct",
    attemptId: retry.results[0]!.completedAttemptId,
  });
  expect(selected.coverage).toMatchObject({
    correct: 1,
    judged: 2,
    reviewed: 1,
  });
  expect(
    (
      await app.execute("runs.assessment", {
        runId: original.run.id,
        passId: human.id,
      })
    ).judgments,
  ).toEqual(human.judgments);
  expect(calls).toEqual(beforeCalls);
});

it("retains a saved judge abstention while recovering the execution", async () => {
  const { app, original, retry, calls } = await setup({ abstainOnRetry: true });
  const beforeCalls = { ...calls };
  const applied = await app.execute("runs.apply-retry", {
    runId: original.run.id,
    retryRunId: retry.run.id,
    idempotencyKey: "abstention",
  });
  const view = await app.execute("runs.get", { runId: original.run.id });
  expect(view.progress).toEqual({ completed: 2, failed: 0, total: 2 });
  const passes = await Promise.all(
    applied.assessmentPassIds.map((passId) =>
      app.execute("runs.assessment", { runId: original.run.id, passId }),
    ),
  );
  const llm = passes.find((pass) => pass.source === "llm")!;
  const resultId = original.results.find(
    (result) => result.questionId === "retry",
  )!.id;
  expect(
    llm.judgments.find((judgment) => judgment.resultId === resultId),
  ).toMatchObject({
    status: "unjudged",
    attemptId: retry.results[0]!.completedAttemptId,
  });
  expect(llm.coverage).toMatchObject({ answered: 2, judged: 1, unjudged: 1 });
  expect(calls).toEqual(beforeCalls);
});

it("rejects failed retry evidence and invalid selected results", async () => {
  const { app, original, retry } = await setup({ failedRetry: true });
  await expect(
    app.execute("runs.apply-retry", {
      runId: original.run.id,
      retryRunId: retry.run.id,
      idempotencyKey: "failed-retry",
    }),
  ).rejects.toThrow();
  const ok = original.results.find((result) => result.questionId === "ok")!;
  await expect(
    app.execute("runs.apply-retry", {
      runId: original.run.id,
      retryRunId: retry.run.id,
      resultIds: [ok.id],
      idempotencyKey: "completed-selection",
    }),
  ).rejects.toThrow();
  expect(
    (await app.execute("runs.get", { runId: original.run.id })).progress,
  ).toEqual(original.progress);
});

it("applies only selected repetitions and combines another recovery without erasing the first", async () => {
  const { app, original, retry, calls } = await setup({ repetitions: 2 });
  const failed = original.results.filter(
    (result) => result.questionId === "retry",
  );
  const beforeCalls = { ...calls };
  const first = await app.execute("runs.apply-retry", {
    runId: original.run.id,
    retryRunId: retry.run.id,
    resultIds: [failed[0]!.id],
    idempotencyKey: "first-repetition",
  });
  expect(first.appliedResultIds).toEqual([failed[0]!.id]);
  expect(
    (await app.execute("runs.get", { runId: original.run.id })).progress,
  ).toEqual({ completed: 3, failed: 1, total: 4 });
  await app.execute("runs.apply-retry", {
    runId: original.run.id,
    retryRunId: retry.run.id,
    resultIds: [failed[1]!.id],
    idempotencyKey: "second-repetition",
  });
  const view = await app.execute("runs.get", { runId: original.run.id });
  expect(view.progress).toEqual({ completed: 4, failed: 0, total: 4 });
  for (const result of failed) {
    const retryResult = retry.results.find(
      (candidate) =>
        candidate.questionId === result.questionId &&
        candidate.repetition === result.repetition,
    )!;
    expect(
      view.results.find((candidate) => candidate.id === result.id)
        ?.answerSource,
    ).toMatchObject({
      resultId: retryResult.id,
      attemptId: retryResult.completedAttemptId,
    });
  }
  expect(calls).toEqual(beforeCalls);
});
