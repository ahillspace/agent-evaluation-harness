import { targetFixture } from "../../tests/fixtures/runtime-targets.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  agentSchema,
  jevProfileSettingsSchema,
  type RuntimePort,
  type JudgeEvidence,
  type Question,
} from "../contracts.js";
import { createApplication } from "./application.js";
import { Database } from "../storage/database.js";
import { digest } from "../domain/identity.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup(
  questions: Question[] = [
    { id: "q1", text: "Answer?", expected: 42, tags: [] },
  ],
) {
  const directory = await mkdtemp(join(tmpdir(), "aeh-jev-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  let targetCalls = 0,
    judgeCalls = 0,
    llmCalls = 0;
  const evidence: JudgeEvidence[] = [];
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
    testConnection: async () => ({ ok: true, message: "ok" }),
    execute: async (input) => {
      targetCalls++;
      input.onEvent({
        type: "tool.completed",
        message: "Result",
        data: { answer: 42 },
      });
      return {
        answer: 42,
        text: "42",
        transcript: [{ tool: "query", result: 42 }],
        usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.01 },
      };
    },
    judge: async () => {
      llmCalls++;
      return {
        verdict: true,
        explanation: "PREVIOUS_JUDGE_SENTINEL",
        usage: { inputTokens: 5, outputTokens: 1, costUsd: 0.01 },
      };
    },
    researcher: async () => {
      throw new Error("Unused");
    },
    classifier: {
      resolveConnection: async (connectionId) => ({
        connectionId,
        provider: "typesafe",
        settings: {},
        credentialFields: ["apiKey"],
      }),
      evaluate: async (input) => {
        judgeCalls++;
        evidence.push(input.evidence);
        const request = JSON.parse(
          JSON.stringify({
            state: input.evidence,
            model: input.configuration.model,
            questions: input.criteria.checks,
          }),
        );
        input.onRequest(request);
        return {
          request,
          response: { model: "jev-1.13.0", answers: {} },
          model: "jev-1.13.0",
          checks: {
            answer: {
              choice: "acceptable",
              probabilities: {
                acceptable: 0.9,
                incorrect: 0.05,
                insufficient_evidence: 0.05,
              },
              confidence: 0.9,
            },
            evidence: {
              choice: "supported",
              probabilities: {
                supported: 0.9,
                contradicted: 0.05,
                insufficient_evidence: 0.05,
              },
              confidence: 0.9,
            },
            reference: {
              choice: "consistent",
              probabilities: {
                consistent: 0.9,
                suspected_issue: 0.05,
                unknown: 0.05,
              },
              confidence: 0.9,
            },
          },
          usage: { inputTokens: 20, outputTokens: 1, costUsd: 0.001 },
        };
      },
    },
  };
  const app = await createApplication({ dataDirectory: directory, runtime });
  cleanups.push(() => app.close());
  const bank = await app.execute("banks.create", {
    name: "Bank",
    questions,
  });
  const profile = await app.execute("jev.profiles.publish", {
    bankId: bank.bankId,
    name: "Default Jev",
    settings: jevProfileSettingsSchema.parse({}),
  });
  const agent = agentSchema.parse({ harness: "codex", model: "fixture" });
  return {
    directory,
    app,
    bank,
    profile,
    agent,
    evidence,
    runtime,
    counts: () => ({ targetCalls, judgeCalls, llmCalls }),
  };
}

it("rejects Jev launch when its saved connection has no bank profile", async () => {
  const { app, bank, agent, counts } = await setup();
  const bankWithoutProfile = await app.execute("banks.create", {
    name: "Bank without Jev profile",
    questions: bank.questions,
  });

  await expect(
    app.execute("runs.launch", {
      bankRevisionId: bankWithoutProfile.id,
      agent,
      jevJudge: { connectionId: "typesafe" },
    }),
  ).rejects.toThrow("Publish a Jev profile for this bank before enabling Jev.");
  expect(counts()).toEqual({ targetCalls: 0, judgeCalls: 0, llmCalls: 0 });
});

it("keeps confident answer verdicts despite secondary Jev review flags", async () => {
  const questions: Question[] = [
    { id: "acceptable", text: "Acceptable answer?", expected: 42, tags: [] },
    { id: "incorrect", text: "Incorrect answer?", expected: 43, tags: [] },
    { id: "low-confidence", text: "Low confidence?", expected: 42, tags: [] },
    { id: "abstain", text: "Insufficient evidence?", expected: 42, tags: [] },
  ];
  const { app, bank, agent, runtime, counts } = await setup(questions);
  const evaluate = runtime.classifier!.evaluate;
  runtime.classifier!.evaluate = async (input) => {
    const result = await evaluate(input);
    const id = input.evidence.question.id;
    const choice =
      id === "incorrect"
        ? "incorrect"
        : id === "abstain"
          ? "insufficient_evidence"
          : "acceptable";
    const confidence =
      id === "low-confidence" ? 0.69 : id === "abstain" ? 0.9 : 0.71;
    result.checks.answer = {
      choice,
      confidence,
      probabilities: {
        acceptable: choice === "acceptable" ? confidence : 0.05,
        incorrect: choice === "incorrect" ? confidence : 0.05,
        insufficient_evidence:
          choice === "insufficient_evidence" ? confidence : 0.05,
      },
    };
    result.checks.reference = {
      choice: "unknown",
      confidence: 0.9,
      probabilities: { consistent: 0.05, suspected_issue: 0.05, unknown: 0.9 },
    };
    return result;
  };

  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
    jevJudge: { connectionId: "typesafe" },
  });
  await app.waitForIdle();
  const view = await app.execute("runs.get", { runId: launched.run.id });
  const summary = view.assessmentPasses?.find((pass) => pass.source === "jev");
  const pass = await app.execute("runs.assessment", {
    runId: launched.run.id,
    passId: summary!.id,
  });
  const statuses = Object.fromEntries(
    pass.judgments.map((judgment) => {
      const question = questions.find(
        (item) =>
          item.id ===
          view.results.find((result) => result.id === judgment.resultId)!
            .questionId,
      )!;
      return [question.id, judgment.status];
    }),
  );

  expect(statuses).toEqual({
    acceptable: "correct",
    incorrect: "incorrect",
    "low-confidence": "unjudged",
    abstain: "unjudged",
  });
  expect(
    view.jevAssessments.every((assessment) => assessment.reviewRequired),
  ).toBe(true);

  const namedPass = await app.execute("runs.assess", {
    runId: launched.run.id,
    name: "Answer decisions",
    source: "jev",
    jevJudge: { connectionId: "typesafe" },
  });
  expect(
    Object.fromEntries(
      namedPass.judgments.map((judgment) => {
        const question = questions.find(
          (item) =>
            item.id ===
            view.results.find((result) => result.id === judgment.resultId)
              ?.questionId,
        )!;
        return [question.id, judgment.status];
      }),
    ),
  ).toEqual(statuses);
  expect(
    namedPass.judgments.every((judgment) => judgment.jevAssessmentId),
  ).toBe(true);
  expect(counts()).toMatchObject({ targetCalls: 4, judgeCalls: 8 });
});

it("freezes independent Jev and LLM judges and publishes saved-evidence previews without target or judge reruns", async () => {
  const { app, bank, profile, agent, evidence, counts } = await setup();
  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
    judge: { enabled: true, agent },
    jevJudge: { connectionId: "typesafe" },
  });
  await app.waitForIdle();
  const run = await app.execute("runs.get", { runId: launched.run.id });
  expect(run.jevAssessments).toHaveLength(1);
  expect(run.run.manifest.jevJudge?.profile.id).toBe(profile.id);
  expect(counts()).toEqual({ targetCalls: 1, judgeCalls: 1, llmCalls: 1 });
  expect(evidence[0]?.trace.format).toBe("provider_transcript");
  expect(JSON.stringify(evidence)).not.toContain("PREVIOUS_JUDGE_SENTINEL");
  expect(evidence[0]?.referenceCriteria).toMatchObject({
    absoluteTolerance: 0.000001,
  });
  await app.execute("jev.profiles.publish", {
    bankId: bank.bankId,
    name: "Changed",
    settings: jevProfileSettingsSchema.parse({
      instructions: "Changed instructions",
    }),
  });
  const preview = await app.execute("jev.preview", {
    runId: run.run.id,
    attemptId: run.attempts[0]!.id,
    idempotencyKey: "once",
  });
  expect(preview.configuration.profile.id).toBe(profile.id);
  expect(preview.published).toBe(false);
  expect(preview.status).toBe("completed");
  const repeated = await app.execute("jev.preview", {
    runId: run.run.id,
    attemptId: run.attempts[0]!.id,
    idempotencyKey: "once",
  });
  expect(repeated.id).toBe(preview.id);
  const published = await app.execute("jev.publish", {
    assessmentId: preview.id,
  });
  expect(published.published).toBe(true);
  expect(published.request).toEqual(preview.request);
  expect(counts()).toEqual({ targetCalls: 1, judgeCalls: 2, llmCalls: 1 });
  const after = await app.execute("runs.get", { runId: run.run.id });
  expect(after.scoreSets).toEqual(run.scoreSets);
  expect(JSON.stringify(after.jevAssessments)).not.toContain('"request"');
  expect(after.jevAssessments).toHaveLength(2);
});

it("preserves completed judge records and recovers pending requests without another provider call", async () => {
  const { app, bank, agent, directory, runtime, counts } = await setup();
  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
    jevJudge: { connectionId: "typesafe" },
  });
  await app.waitForIdle();
  const view = await app.execute("runs.get", { runId: launched.run.id });
  const completed = await app.execute("jev.get", {
    assessmentId: view.jevAssessments[0]!.id,
  });
  await app.close();
  const db = new Database(join(directory, "workspace.sqlite"));
  expect(() =>
    db.update("jevAssessment", { ...completed, response: { changed: true } }),
  ).toThrow(/immutable/);
  expect(() =>
    db.update("jevAssessment", { ...completed, published: false }),
  ).toThrow(/unpublished/);
  const {
    checks: _checks,
    response: _response,
    usage: _usage,
    finishedAt: _finishedAt,
    ...pending
  } = completed;
  db.insert("jevAssessment", {
    ...pending,
    id: "pending-request",
    kind: "rejudge",
    status: "pending",
    published: false,
  });
  db.close();
  const restarted = await createApplication({
    dataDirectory: directory,
    runtime,
  });
  cleanups.push(() => restarted.close());
  const recovered = await restarted.execute("jev.get", {
    assessmentId: "pending-request",
  });
  expect(recovered.status).toBe("error");
  expect(recovered.error?.code).toBe("interrupted");
  expect(recovered.request).toEqual(completed.request);
  expect(recovered.usage).toBeUndefined();
  expect(counts().judgeCalls).toBe(1);
});

it("counts Jev usage in research budgets before admitting a researcher turn", async () => {
  const { app, bank, agent, counts } = await setup();
  const research = await app.execute("research.launch", {
    baseline: {
      bankRevisionId: bank.id,
      agent,
      jevJudge: { connectionId: "typesafe" },
    },
    researcher: agent,
    objective: "Improve accuracy",
    maxTotalTokens: 20,
  });
  await app.waitForIdle();
  const view = await app.execute("research.get", {
    sessionId: research.session.id,
  });
  expect(view.session.status).toBe("completed");
  expect(view.session.turns).toHaveLength(0);
  expect(view.events.some((event) => /Token budget/.test(event.message))).toBe(
    true,
  );
  expect(counts()).toEqual({ targetCalls: 1, judgeCalls: 1, llmCalls: 0 });
});

it("inherits bank criteria when a question override changes only instructions", async () => {
  const { app, bank, agent } = await setup();
  const settings = jevProfileSettingsSchema.parse({
    checks: {
      answer: {
        criteria: { acceptable: "Accept equivalent totals rounded to cents." },
      },
    },
    questionOverrides: {
      q1: {
        checks: { answer: { instructions: "Use the sales question rules." } },
      },
    },
  });
  await app.execute("jev.profiles.publish", {
    bankId: bank.bankId,
    name: "Override",
    settings,
  });
  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
    jevJudge: { connectionId: "typesafe" },
  });
  await app.waitForIdle();
  const view = await app.execute("runs.get", { runId: launched.run.id });
  const record = await app.execute("jev.get", {
    assessmentId: view.jevAssessments[0]!.id,
  });
  expect(record.criteria.checks.answer.instructions).toBe(
    "Use the sales question rules.",
  );
  expect(record.criteria.checks.answer.criteria.acceptable).toBe(
    "Accept equivalent totals rounded to cents.",
  );
});

it("recovers an explicit unavailable Jev assessment when an answer was sealed before judge admission", async () => {
  const { app, bank, agent, directory, runtime, counts } = await setup();
  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
    jevJudge: { connectionId: "typesafe" },
  });
  await app.waitForIdle();
  const view = await app.execute("runs.get", { runId: launched.run.id });
  const detail = await app.execute("runs.attempt", {
    runId: view.run.id,
    attemptId: view.attempts[0]!.id,
  });
  await app.close();
  const db = new Database(join(directory, "workspace.sqlite"));
  db.insert("run", { ...view.run, id: "interrupted-run" });
  db.insert("result", {
    ...view.results[0]!,
    id: "interrupted-result",
    runId: "interrupted-run",
    attemptIds: ["interrupted-attempt"],
    completedAttemptId: "interrupted-attempt",
  });
  db.insert("attempt", {
    ...detail.attempt,
    id: "interrupted-attempt",
    runId: "interrupted-run",
    resultId: "interrupted-result",
  });
  db.close();
  const restarted = await createApplication({
    dataDirectory: directory,
    runtime,
  });
  cleanups.push(() => restarted.close());
  const recovered = await restarted.execute("runs.get", {
    runId: "interrupted-run",
  });
  expect(recovered.jevAssessments).toHaveLength(1);
  expect(recovered.jevAssessments[0]?.error?.code).toBe("not_evaluated");
  expect(recovered.jevAssessments[0]?.usage).toEqual({
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  });
  expect(counts().judgeCalls).toBe(1);
});

it("requests review when confident Jev checks contradict one another", async () => {
  const { app, bank, agent, runtime } = await setup();
  const evaluate = runtime.classifier!.evaluate;
  runtime.classifier!.evaluate = async (input) => {
    const result = await evaluate(input);
    result.checks.evidence = {
      choice: "contradicted",
      probabilities: {
        supported: 0.05,
        contradicted: 0.9,
        insufficient_evidence: 0.05,
      },
      confidence: 0.9,
    };
    return result;
  };
  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
    jevJudge: { connectionId: "typesafe" },
  });
  await app.waitForIdle();
  const view = await app.execute("runs.get", { runId: launched.run.id });
  expect(view.jevAssessments[0]?.checks?.answer?.choice).toBe("acceptable");
  expect(view.jevAssessments[0]?.checks?.evidence?.choice).toBe("contradicted");
  expect(view.jevAssessments[0]?.reviewRequired).toBe(true);
  expect(view.scoreSets[0]?.assessments[0]?.deterministic.status).toBe(
    "correct",
  );
});

it("persists Jev error provenance without converting it into an incorrect deterministic score", async () => {
  const { app, bank, agent, runtime } = await setup();
  runtime.classifier!.evaluate = async (input) => {
    const request = { state: "fixture" };
    input.onRequest(request);
    throw Object.assign(new Error("Capacity exceeded"), {
      code: "capacity",
      request,
      response: { error: "too long" },
      httpStatus: 422,
    });
  };
  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
    jevJudge: { connectionId: "typesafe" },
  });
  await app.waitForIdle();
  const run = await app.execute("runs.get", { runId: launched.run.id });
  expect(run.jevAssessments[0]?.status).toBe("error");
  expect(run.scoreSets[0]?.assessments[0]?.deterministic.status).toBe(
    "correct",
  );
  const record = await app.execute("jev.get", {
    assessmentId: run.jevAssessments[0]!.id,
  });
  expect(record.response).toEqual({ error: "too long" });
  expect(record.httpStatus).toBe(422);
});

it("falls back to recorded activity when a provider supplies an empty transcript", async () => {
  const { app, bank, agent, runtime, evidence } = await setup();
  runtime.execute = async (input) => {
    input.onEvent({
      type: "tool.completed",
      message: "Evidence",
      data: { result: "full-recorded-evidence" },
    });
    return { answer: 42, text: "42", transcript: [] };
  };
  const run = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
    jevJudge: { connectionId: "typesafe" },
  });
  await app.waitForIdle();
  expect(
    (await app.execute("runs.get", { runId: run.run.id })).jevAssessments[0]
      ?.status,
  ).toBe("completed");
  expect(evidence[0]?.trace.format).toBe("recorded_events");
  expect(JSON.stringify(evidence[0]?.trace)).toContain(
    "full-recorded-evidence",
  );
});

it("keeps external evidence answer-only and refuses incompatible saved judging without provider calls", async () => {
  const { app, bank, runtime, evidence, counts } = await setup();
  await app.execute("jev.profiles.publish", {
    bankId: bank.bankId,
    name: "Answer only",
    settings: jevProfileSettingsSchema.parse({ evidenceRequirement: "answer" }),
  });
  runtime.execute = async () => ({
    answer: 42,
    text: "42",
    evidenceScope: "answer-only",
    transcript: [{ misleading: "internal tool" }],
  });
  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    target: {
      kind: "external",
      adapterId: "http",
      adapterVersion: 1,
      name: "Endpoint",
      configuration: {},
    },
    jevJudge: { connectionId: "typesafe" },
  });
  await app.waitForIdle();
  const view = await app.execute("runs.get", { runId: launched.run.id });
  expect(evidence[0]?.trace).toEqual({ format: "unavailable", entries: null });
  expect(evidence[0]?.publicAgent).toBeUndefined();
  expect(evidence[0]?.publicTarget?.kind).toBe("external");
  const incompatible = await app.execute("jev.profiles.publish", {
    bankId: bank.bankId,
    name: "Internal evidence",
    settings: jevProfileSettingsSchema.parse({
      evidenceRequirement: "internal-activity",
    }),
  });
  const before = counts();
  const preview = await app.execute("jev.preview", {
    runId: launched.run.id,
    attemptId: view.attempts[0]!.id,
    configuration: {
      connectionId: "typesafe",
      profileRevisionId: incompatible.id,
    },
  });
  expect(preview.error?.code).toBe("unsupported_evidence");
  expect(counts()).toEqual(before);
});

it("falls back once on trace capacity errors and preserves both call records and usage", async () => {
  const { app, bank, agent, runtime } = await setup();
  const profile = await app.execute("jev.profiles.publish", {
    bankId: bank.bankId,
    name: "Answer-only overflow fallback",
    settings: jevProfileSettingsSchema.parse({
      evidenceRequirement: "internal-activity",
      answerOnlyFallback: {
        instructions:
          "Judge answer correctness from answer and reference only.",
        answer: {
          instructions: "Compare the final answer with expected.",
        },
      },
    }),
  });
  const calls: Array<Record<string, unknown>> = [];
  runtime.classifier!.evaluate = async (input) => {
    calls.push(input as unknown as Record<string, unknown>);
    if (calls.length === 1) {
      const error = Object.assign(new Error("Trace request exceeded tokens."), {
        code: "token_limit_exceeded",
        request: { marker: "full-trace-request" },
        response: { marker: "provider-limit-response" },
        attempts: [
          { status: 413, response: { marker: "provider-limit-response" } },
        ],
        httpStatus: 413,
        usage: { inputTokens: 11, outputTokens: 2, costUsd: 0.11 },
        pricing: {
          model: "jev-1.13.0",
          inputUsdPerMillion: 0.042,
          outputUsdPerMillion: 0,
          source: "fixture",
          basis: "reported_tokens" as const,
        },
      });
      input.onRequest({ marker: "full-trace-request" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw error;
    }
    input.onRequest({ marker: "answer-only-request" });
    return {
      request: { marker: "answer-only-request" },
      response: { marker: "answer-only-response" },
      model: "jev-1.13.0",
      checks: {
        answer: {
          choice: "acceptable",
          probabilities: {
            acceptable: 0.9,
            incorrect: 0.05,
            insufficient_evidence: 0.05,
          },
          confidence: 0.9,
        },
      },
      usage: { inputTokens: 17, outputTokens: 3, costUsd: 0.17 },
    };
  };

  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
    jevJudge: {
      connectionId: "typesafe",
      profileRevisionId: profile.id,
    },
  });
  await app.waitForIdle();
  const view = await app.execute("runs.get", { runId: launched.run.id });
  const record = await app.execute("jev.get", {
    assessmentId: view.jevAssessments[0]!.id,
  });

  expect(calls).toHaveLength(2);
  expect(calls[0]?.scope).toBeUndefined();
  expect(calls[1]?.scope).toBe("answer-only-fallback");
  expect(calls[1]?.timeoutMs).toBeLessThan(calls[0]?.timeoutMs as number);
  expect(record.status).toBe("completed");
  expect(record.evidence.trace.format).toBe("provider_transcript");
  expect(record.request).toEqual({ marker: "answer-only-request" });
  expect(record.checks).toHaveProperty("answer");
  expect(record.checks).not.toHaveProperty("evidence");
  expect(record.checks).not.toHaveProperty("reference");
  expect(record.reviewRequired).toBe(true);
  expect(record.usage).toEqual({
    inputTokens: 28,
    outputTokens: 5,
    costUsd: 0.28,
  });
  expect(record.fallback?.resultUsage).toEqual({
    inputTokens: 17,
    outputTokens: 3,
    costUsd: 0.17,
  });
  expect(view.performance!.judge).toMatchObject({
    calls: 2,
    inputTokens: 28,
    outputTokens: 5,
  });
  expect(record.fallback).toMatchObject({
    trigger: {
      request: { marker: "full-trace-request" },
      response: { marker: "provider-limit-response" },
      httpStatus: 413,
      error: { code: "token_limit_exceeded" },
    },
    criteria: {
      instructions: "Judge answer correctness from answer and reference only.",
      answer: { instructions: "Compare the final answer with expected." },
    },
  });
});

it("keeps initial-request provenance in the trigger when fallback fails before admission", async () => {
  const { app, bank, agent, runtime } = await setup();
  const profile = await app.execute("jev.profiles.publish", {
    bankId: bank.bankId,
    name: "Answer-only overflow fallback failure",
    settings: jevProfileSettingsSchema.parse({
      evidenceRequirement: "internal-activity",
      answerOnlyFallback: {
        instructions: "Compare the submitted answer with the reference.",
        answer: { instructions: "Judge answer correctness." },
      },
    }),
  });
  let calls = 0;
  runtime.classifier!.evaluate = async (input) => {
    calls++;
    if (calls === 1) {
      input.onRequest({ marker: "original-request" });
      throw Object.assign(new Error("Trace request exceeded tokens."), {
        code: "token_limit_exceeded",
      });
    }
    throw Object.assign(new Error("Credentials unavailable."), {
      code: "authentication_failed",
    });
  };

  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
    jevJudge: {
      connectionId: "typesafe",
      profileRevisionId: profile.id,
    },
  });
  await app.waitForIdle();
  const view = await app.execute("runs.get", { runId: launched.run.id });
  const record = await app.execute("jev.get", {
    assessmentId: view.jevAssessments[0]!.id,
  });

  expect(calls).toBe(2);
  expect(record.status).toBe("error");
  expect(record.request).toBeUndefined();
  expect(record.response).toBeUndefined();
  expect(record.fallback?.trigger.request).toEqual({
    marker: "original-request",
  });
  expect(record.fallback?.resultUsage).toBeUndefined();
  expect(record.usage).toBeUndefined();
});

it("does not retry an oversized answer-only request and keeps unknown trigger usage unknown", async () => {
  const { app, bank, agent, runtime } = await setup();
  const profile = await app.execute("jev.profiles.publish", {
    bankId: bank.bankId,
    name: "Still oversized fallback",
    settings: jevProfileSettingsSchema.parse({
      evidenceRequirement: "internal-activity",
      answerOnlyFallback: {
        instructions: "Compare the submitted answer with the reference.",
        answer: { instructions: "Judge answer correctness." },
      },
    }),
  });
  const calls: Array<Record<string, unknown>> = [];
  runtime.classifier!.evaluate = async (input) => {
    calls.push(input as unknown as Record<string, unknown>);
    if (calls.length === 1) {
      input.onRequest({ marker: "full-trace-request" });
      throw Object.assign(new Error("Trace request exceeded tokens."), {
        code: "token_limit_exceeded",
      });
    }
    input.onRequest({ marker: "oversized-answer-request" });
    throw Object.assign(new Error("Answer-only request exceeds local limit."), {
      code: "capacity_exceeded",
      request: { marker: "oversized-answer-request" },
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      },
    });
  };

  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
    jevJudge: {
      connectionId: "typesafe",
      profileRevisionId: profile.id,
    },
  });
  await app.waitForIdle();
  const view = await app.execute("runs.get", { runId: launched.run.id });
  const record = await app.execute("jev.get", {
    assessmentId: view.jevAssessments[0]!.id,
  });

  expect(calls).toHaveLength(2);
  expect(record.status).toBe("error");
  expect(record.error?.code).toBe("capacity_exceeded");
  expect(record.request).toEqual({ marker: "oversized-answer-request" });
  expect(record.fallback?.trigger.request).toEqual({
    marker: "full-trace-request",
  });
  expect(record.fallback?.trigger.usage).toBeUndefined();
  expect(record.fallback?.resultUsage).toEqual({
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  });
  expect(record.usage).toBeUndefined();
  expect(view.performance!.judge).toMatchObject({
    calls: 2,
    inputTokens: 0,
    reporting: { inputTokens: { reported: 1, missing: 1 } },
  });
});

it.each([
  {
    label: "fallback is disabled",
    fallback: false,
    evidenceRequirement: "internal-activity" as const,
    errorCode: "token_limit_exceeded",
  },
  {
    label: "the primary profile is answer-only",
    fallback: true,
    evidenceRequirement: "answer" as const,
    errorCode: "token_limit_exceeded",
  },
  {
    label: "the initial failure is authentication-related",
    fallback: true,
    evidenceRequirement: "internal-activity" as const,
    errorCode: "authentication_failed",
  },
  {
    label: "the initial failure is network-related",
    fallback: true,
    evidenceRequirement: "internal-activity" as const,
    errorCode: "network_error",
  },
])("does not retry when $label", async (testCase) => {
  const { app, bank, agent, runtime } = await setup();
  const profile = await app.execute("jev.profiles.publish", {
    bankId: bank.bankId,
    name: "No fallback retry",
    settings: jevProfileSettingsSchema.parse({
      evidenceRequirement: testCase.evidenceRequirement,
      ...(testCase.fallback
        ? {
            answerOnlyFallback: {
              instructions: "Compare the submitted answer with the reference.",
              answer: { instructions: "Judge answer correctness." },
            },
          }
        : {}),
    }),
  });
  let calls = 0;
  runtime.classifier!.evaluate = async () => {
    calls++;
    throw Object.assign(new Error("Fixture judge failure."), {
      code: testCase.errorCode,
    });
  };

  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
    jevJudge: {
      connectionId: "typesafe",
      profileRevisionId: profile.id,
    },
  });
  await app.waitForIdle();
  const view = await app.execute("runs.get", { runId: launched.run.id });
  const record = await app.execute("jev.get", {
    assessmentId: view.jevAssessments[0]!.id,
  });

  expect(calls).toBe(1);
  expect(record.status).toBe("error");
  expect(record.fallback).toBeUndefined();
});

it("sends an answer-only projection while preserving full sealed evidence and criteria", async () => {
  const { app, bank, agent, evidence } = await setup();
  const profile = await app.execute("jev.profiles.publish", {
    bankId: bank.bankId,
    name: "Answer-only correctness",
    settings: jevProfileSettingsSchema.parse({
      evidenceRequirement: "answer",
    }),
  });
  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
    jevJudge: {
      connectionId: "typesafe",
      profileRevisionId: profile.id,
    },
  });
  await app.waitForIdle();

  const view = await app.execute("runs.get", { runId: launched.run.id });
  const record = await app.execute("jev.get", {
    assessmentId: view.jevAssessments[0]!.id,
  });

  expect(evidence[0]?.observationLevel).toBe("answer-only");
  expect(evidence[0]?.trace).toEqual({ format: "unavailable", entries: null });
  expect(record.evidence.trace.format).toBe("provider_transcript");
  expect(JSON.stringify(record.evidence.trace)).toContain("query");
  expect(record.evidenceHash).toBe(digest(record.evidence));
  const attemptDetail = await app.execute("runs.attempt", {
    runId: view.run.id,
    attemptId: view.attempts[0]!.id,
  });
  expect(record.attemptEvidenceHash).toBe(attemptDetail.attempt.evidenceHash);
  expect(record.request).toMatchObject({
    state: evidence[0],
    questions: {
      answer: { criteria: profile.settings.checks.answer.criteria },
      evidence: { criteria: profile.settings.checks.evidence.criteria },
      reference: { criteria: profile.settings.checks.reference.criteria },
    },
  });

  const internalProfile = await app.execute("jev.profiles.publish", {
    bankId: bank.bankId,
    name: "Internal-activity review",
    settings: jevProfileSettingsSchema.parse({
      evidenceRequirement: "internal-activity",
    }),
  });
  const internalPreview = await app.execute("jev.preview", {
    runId: view.run.id,
    attemptId: view.attempts[0]!.id,
    configuration: {
      connectionId: "typesafe",
      profileRevisionId: internalProfile.id,
    },
  });
  const internalRecord = await app.execute("jev.get", {
    assessmentId: internalPreview.id,
  });
  expect(evidence[1]?.trace).toEqual(record.evidence.trace);
  expect(internalRecord.request).toMatchObject({
    state: { trace: record.evidence.trace },
  });
});
