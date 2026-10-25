import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createApplication } from "./application.js";
import type { AgentConfig, RuntimePort } from "../contracts.js";
import { targetFixture } from "../../tests/fixtures/runtime-targets.js";
import { Database } from "../storage/database.js";
import {
  AssessmentPassService,
  measurePass,
  summarizePass,
} from "./assessment-passes.js";
import { EvaluationService } from "./evaluations.js";
import { JevService } from "./jev.js";

it("saves independent passes and carries untouched judgments and failed-answer notes without target replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeh-passes-"));
  let calls = 0;
  const agent: AgentConfig = {
    harness: "codex",
    model: "fixture",
    systemPrompt: "Answer.",
    settings: {},
    tools: [],
    connections: [],
  };
  const runtime: RuntimePort = {
    ...targetFixture,
    resolveAgent: async (v) => v,
    discover: async () => ({
      harnesses: [],
      connectionProviders: [],
      maxConcurrency: 1,
    }),
    recover: async () => ({ recovered: [], errors: [] }),
    close: async () => {},
    listConnections: async () => [],
    saveConnection: async () => {
      throw Error("unused");
    },
    deleteConnection: async () => {},
    testConnection: async () => ({ ok: true, message: "ok" }),
    execute: async (input) => {
      calls++;
      if (input.question.id === "failed") throw Error("fixture failure");
      return { answer: 42, text: "42" };
    },
    judge: async () => ({ verdict: true }),
    researcher: async () => {
      throw Error("unused");
    },
  };
  const app = await createApplication({ dataDirectory: directory, runtime });
  try {
    const bank = await app.execute("banks.create", {
      name: "Bank",
      questions: [
        { id: "ok", text: "Answer", expected: 42 },
        { id: "failed", text: "Failure", expected: 42 },
      ],
    });
    const launch = await app.execute("runs.launch", {
      bankRevisionId: bank.id,
      agent,
    });
    await app.waitForIdle();
    const pass = await app.execute("runs.assess", {
      runId: launch.run.id,
      name: "Published standard",
      source: "deterministic",
    });
    expect(pass.coverage).toMatchObject({
      eligible: 2,
      answered: 1,
      correct: 1,
      unjudged: 1,
    });
    expect(pass.accuracy).toBe(1);
    expect(pass.eligibleOutcome).toBe(0.5);
    const failed = pass.judgments.find((j) => j.status === "unjudged")!;
    const human = await app.execute("runs.review-assessment", {
      runId: launch.run.id,
      parentPassId: pass.id,
      name: "Reviewed",
      overrides: [
        {
          resultId: failed.resultId,
          verdict: null,
          note: "Execution needs attention",
        },
      ],
    });
    expect(
      human.judgments.find((j) => j.resultId === failed.resultId),
    ).toMatchObject({
      status: "unjudged",
      review: { note: "Execution needs attention" },
    });
    expect(human.coverage).toMatchObject({
      correct: 1,
      reviewed: 1,
      overridden: 0,
    });
    expect(calls).toBe(2);
    await app.execute("runs.select-assessment", {
      runId: launch.run.id,
      passId: human.id,
    });
    expect(
      (await app.execute("runs.get", { runId: launch.run.id }))
        .selectedAssessmentPassId,
    ).toBe(human.id);
    expect(
      (
        await app.execute("runs.export-assessment", {
          runId: launch.run.id,
          passId: pass.id,
        })
      ).judgments,
    ).toEqual(pass.judgments);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("recovers unfinished judgments without converting a completed abstention into a retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeh-pass-recovery-"));
  const db = new Database(join(directory, "workspace.sqlite"));
  try {
    const pass = measurePass({
      id: "interrupted",
      runId: "run",
      name: "Interrupted custom judge",
      source: "llm",
      status: "running",
      createdAt: new Date().toISOString(),
      configuration: {},
      basis: {
        bankRevisionId: "bank",
        evaluatorRevisionId: "evaluator",
        eligibleResultIds: ["abstained", "unfinished"],
        excludedResultIds: [],
        referenceHash: "reference",
      },
      judgments: [
        {
          resultId: "abstained",
          attemptId: "a1",
          status: "unjudged",
          explanation: "Reference is ambiguous.",
          response: { verdict: null },
        },
        {
          resultId: "unfinished",
          attemptId: "a2",
          status: "unjudged",
          explanation: "Pending.",
        },
      ],
      coverage: {
        eligible: 2,
        answered: 2,
        judged: 0,
        correct: 0,
        incorrect: 0,
        unjudged: 2,
        errors: 0,
        excluded: 0,
        reviewed: 0,
        overridden: 0,
      },
      accuracy: 0,
      judgedAccuracy: null,
    });
    db.insert("assessmentPass", pass);
    const runtime = {} as RuntimePort;
    new AssessmentPassService(
      db,
      new EvaluationService(db),
      new JevService(db, runtime),
      runtime,
      directory,
    ).recover();
    const recovered = db.require("assessmentPass", pass.id);
    expect(recovered.judgments.map((j) => j.status)).toEqual([
      "unjudged",
      "error",
    ]);
    expect(recovered.retryableJudgments).toBe(1);
    expect(() =>
      db.update("assessmentPass", { ...recovered, name: "Changed" }),
    ).toThrow(/immutable/i);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps full comparison evidence available without copying it into observation and run summaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeh-pass-projection-"));
  const db = new Database(join(directory, "workspace.sqlite"));
  try {
    const details = {
      rows: Array.from({ length: 2000 }, (_, index) => ({
        name: `Row ${index}`,
        value: index,
      })),
    };
    const pass = measurePass({
      id: "large-pass",
      runId: "run",
      name: "Large comparison",
      source: "deterministic",
      status: "completed",
      createdAt: new Date().toISOString(),
      configuration: {},
      basis: {
        bankRevisionId: "bank",
        evaluatorRevisionId: "evaluator",
        eligibleResultIds: ["result"],
        excludedResultIds: [],
        referenceHash: "reference",
      },
      judgments: [
        {
          resultId: "result",
          attemptId: "attempt",
          status: "incorrect",
          explanation: "Values differ.",
          details,
          request: { fixture: true },
          response: { fixture: true },
        },
      ],
      coverage: {
        eligible: 1,
        answered: 1,
        judged: 1,
        correct: 0,
        incorrect: 1,
        unjudged: 0,
        errors: 0,
        excluded: 0,
        reviewed: 0,
        overridden: 0,
      },
      accuracy: 0,
      judgedAccuracy: 0,
    });
    db.insert("assessmentPass", pass);
    const observation = db.assessmentPassObservations(pass.runId)[0]!;
    expect(Object.hasOwn(observation.judgments[0]!, "details")).toBe(false);
    expect(observation.judgments[0]).not.toHaveProperty("request");
    expect(observation.judgments[0]).not.toHaveProperty("response");
    const summary = summarizePass(observation);
    expect(summary.basis).not.toHaveProperty("eligibleResultIds");
    expect(summary.basis).not.toHaveProperty("excludedResultIds");
    expect(summary.coverage).toMatchObject({ eligible: 1, incorrect: 1 });
    const runtime = {} as RuntimePort;
    const service = new AssessmentPassService(
      db,
      new EvaluationService(db),
      new JevService(db, runtime),
      runtime,
      directory,
    );
    expect(service.get(pass.runId, pass.id).judgments[0]?.details).toEqual(
      details,
    );
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("retries only failed LLM judgments and preserves the original pass and reference revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeh-pass-retry-"));
  let targetCalls = 0,
    judgeCalls = 0;
  let enterRetry!: () => void, releaseRetry!: () => void;
  const retryStarted = new Promise<void>((resolve) => {
    enterRetry = resolve;
  });
  const retryGate = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  const agent: AgentConfig = {
    harness: "codex",
    model: "fixture",
    systemPrompt: "Answer.",
    settings: {},
    tools: [],
    connections: [],
  };
  const runtime: RuntimePort = {
    ...targetFixture,
    resolveAgent: async (v) => v,
    discover: async () => ({
      harnesses: [],
      connectionProviders: [],
      maxConcurrency: 1,
    }),
    recover: async () => ({ recovered: [], errors: [] }),
    close: async () => {},
    listConnections: async () => [],
    saveConnection: async () => {
      throw Error("unused");
    },
    deleteConnection: async () => {},
    testConnection: async () => ({ ok: true, message: "ok" }),
    execute: async () => {
      targetCalls++;
      return { answer: 42, text: "42" };
    },
    judge: async (input) => {
      judgeCalls++;
      if (input.evidence.question.id === "q2" && judgeCalls === 2)
        throw Error("temporary judge failure");
      if (judgeCalls === 3) {
        enterRetry();
        await retryGate;
      }
      return {
        verdict: true,
        usage: { inputTokens: 5, outputTokens: 2, costUsd: 0 },
      };
    },
    researcher: async () => {
      throw Error("unused");
    },
  };
  const app = await createApplication({ dataDirectory: directory, runtime });
  try {
    const bank = await app.execute("banks.create", {
      name: "Bank",
      questions: [
        { id: "q1", text: "One", expected: 42 },
        { id: "q2", text: "Two", expected: 42 },
      ],
    });
    const launched = await app.execute("runs.launch", {
      bankRevisionId: bank.id,
      agent,
    });
    await app.waitForIdle();
    const pass = await app.execute("runs.assess", {
      runId: launched.run.id,
      name: "Custom judge",
      source: "llm",
      judge: { enabled: true, agent, instructions: "Judge the saved answer." },
    });
    expect(pass.coverage).toMatchObject({ eligible: 2, judged: 1, errors: 1 });
    expect(pass.configuration.referenceBank?.id).toBe(bank.id);
    const retryPromise = app.execute("runs.retry-assessment", {
      runId: launched.run.id,
      passId: pass.id,
    });
    await retryStarted;
    const pendingView = await app.execute("runs.get", {
      runId: launched.run.id,
    });
    releaseRetry();
    const retried = await retryPromise;
    expect(pendingView.performance?.judge).toMatchObject({
      inputTokens: 5,
      calls: 3,
      reporting: { inputTokens: { reported: 1, missing: 1, pending: 1 } },
    });
    expect(retried.coverage).toMatchObject({ judged: 2, errors: 0 });
    expect(retried.parentPassId).toBe(pass.id);
    expect(judgeCalls).toBe(3);
    expect(targetCalls).toBe(2);
    expect(
      (
        await app.execute("runs.assessment", {
          runId: launched.run.id,
          passId: pass.id,
        })
      ).coverage.errors,
    ).toBe(1);
    const view = await app.execute("runs.get", { runId: launched.run.id });
    expect(view.performance?.judge.calls).toBe(3);
    expect(view.performance?.judge.inputTokens).toBe(10);
    expect(view.performance?.judge.reporting?.inputTokens).toEqual({
      reported: 2,
      missing: 1,
      pending: 0,
    });
    expect(
      view.assessmentPasses?.find((p) => p.id === retried.id)?.configuration,
    ).toEqual({});
    const finding = await app.execute("banks.report-finding", {
      bankId: bank.bankId,
      bankRevisionId: bank.id,
      questionId: "q1",
      kind: "reference",
      title: "Reference correction",
      runId: launched.run.id,
      resultId: pass.judgments[0]!.resultId,
    });
    const resolution = await app.execute("banks.resolve-finding", {
      findingId: finding.id,
      status: "accepted",
      expected: 43,
      note: "Reviewed source evidence",
    });
    expect(resolution.bankRevision?.number).toBe(2);
    expect(
      (
        await app.execute("runs.assessment", {
          runId: launched.run.id,
          passId: pass.id,
        })
      ).configuration.referenceBank?.questions[0]?.expected,
    ).toBe(42);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
