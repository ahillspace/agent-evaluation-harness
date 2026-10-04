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
} from "../contracts.js";
import { createApplication } from "./application.js";
import { Database } from "../storage/database.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
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
    questions: [{ id: "q1", text: "Answer?", expected: 42 }],
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
  expect(view.jevAssessments[0]?.checks?.answer.choice).toBe("acceptable");
  expect(view.jevAssessments[0]?.checks?.evidence.choice).toBe("contradicted");
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
