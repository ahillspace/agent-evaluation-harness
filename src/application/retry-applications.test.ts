import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  agentSchema,
  evaluatorSettingsSchema,
  judgeSchema,
  jevProfileSettingsSchema,
  type Verdict,
  limitsSchema,
  type RunRecord,
  type Json,
  type RuntimePort,
} from "../contracts.js";
import { digest } from "../domain/identity.js";
import { Database } from "../storage/database.js";
import { AnswerSources } from "./answer-sources.js";
import { AssessmentPassService, summarizePass } from "./assessment-passes.js";
import { EvaluationService } from "./evaluations.js";
import { JevService } from "./jev.js";
import { RetryApplicationService } from "./retry-applications.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(expected: Json = 42) {
  const directory = await mkdtemp(
    join(tmpdir(), "aeh-retry-application-policy-"),
  );
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const db = new Database(join(directory, "workspace.sqlite"));
  cleanups.push(async () => db.close());
  const timestamp = "2026-10-12T00:00:00Z";
  const questions = ["ok", "a", "b", "c"].map((id) => ({
    id,
    text: id,
    expected,
    tags: [],
  }));
  const bank = {
    id: "bankrev",
    bankId: "bank",
    number: 1,
    createdAt: timestamp,
    name: "Bank",
    questions,
    digest: digest(questions),
  };
  const evaluator = {
    id: "evaluator",
    bankId: "bank",
    number: 1,
    createdAt: timestamp,
    name: "Answers",
    settings: evaluatorSettingsSchema.parse({}),
    digest: "eval",
  };
  const run: RunRecord = {
    id: "original",
    name: "Original",
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "completed",
    intent: "run",
    manifest: {
      bank,
      evaluator,
      questions,
      repetitions: 1,
      agent: agentSchema.parse({ harness: "codex", model: "fixture" }),
      judge: judgeSchema.parse({}),
      limits: limitsSchema.parse({}),
      digest: "manifest",
    },
  };
  db.insert("run", run);
  for (const question of questions) {
    const completed = question.id === "ok";
    const output = {
      answer: 42,
      text: "42",
      usage: { inputTokens: 10, outputTokens: 1 },
    };
    db.insert("result", {
      id: question.id,
      runId: run.id,
      questionId: question.id,
      repetition: 1,
      status: completed ? "completed" : "failed",
      attemptIds: [`attempt_${question.id}`],
      ...(completed ? { completedAttemptId: `attempt_${question.id}` } : {}),
    });
    db.insert("attempt", {
      id: `attempt_${question.id}`,
      runId: run.id,
      resultId: question.id,
      number: 1,
      status: completed ? "completed" : "failed",
      startedAt: timestamp,
      finishedAt: timestamp,
      ...(completed
        ? { output, evidenceHash: digest(output) }
        : { error: "Tool failure" }),
    });
  }
  function addRetry(
    retryId: string,
    changedManifest = false,
    wrongRepetition = false,
  ) {
    db.insert("run", {
      ...run,
      id: retryId,
      name: retryId,
      manifest: changedManifest
        ? {
            ...run.manifest,
            limits: { ...run.manifest.limits, timeoutMs: 6001 },
          }
        : run.manifest,
      retryOf: { runId: run.id, resultIds: ["a", "b", "c"] },
    });
    for (const questionId of ["a", "b", "c"]) {
      const attemptId = `${retryId}_attempt_${questionId}`,
        resultId = `${retryId}_${questionId}`;
      const output = {
        answer: 42,
        text: "42",
        usage: { inputTokens: 10, outputTokens: 1 },
      };
      db.insert("result", {
        id: resultId,
        runId: retryId,
        questionId,
        repetition: wrongRepetition ? 2 : 1,
        status: "completed",
        attemptIds: [attemptId],
        completedAttemptId: attemptId,
      });
      db.insert("attempt", {
        id: attemptId,
        runId: retryId,
        resultId,
        number: 1,
        status: "completed",
        startedAt: timestamp,
        finishedAt: timestamp,
        output,
        evidenceHash: digest(output),
      });
    }
  }
  addRetry("retry");
  const runtime = {} as RuntimePort;
  const evaluations = new EvaluationService(db);
  const passes = new AssessmentPassService(
    db,
    evaluations,
    new JevService(db, runtime),
    runtime,
    directory,
  );
  const service = new RetryApplicationService(db, passes, evaluations);
  return { db, run, addRetry, passes, service, sources: new AnswerSources(db) };
}

it("accumulates three partial applications while retaining unrelated human decisions", async () => {
  const { db, passes, service } = await fixture();
  const original = passes.list("original", true)[0]!;
  passes.review({
    runId: "original",
    parentPassId: original.id,
    name: "Reviewed",
    overrides: [{ resultId: "ok", verdict: false, note: "Reviewed answer" }],
  });
  for (const resultId of ["a", "b", "c"]) {
    await service.apply({
      runId: "original",
      retryRunId: "retry",
      resultIds: [resultId],
      idempotencyKey: resultId,
    });
    const selected = passes.get(
      "original",
      db.require("run", "original").selectedAssessmentPassId!,
    );
    expect(selected.source).toBe("human");
    expect(
      selected.judgments.find((judgment) => judgment.resultId === "ok"),
    ).toMatchObject({
      status: "incorrect",
      review: { note: "Reviewed answer" },
    });
  }
  const selected = passes.get(
    "original",
    db.require("run", "original").selectedAssessmentPassId!,
  );
  expect(selected.coverage).toMatchObject({
    answered: 4,
    reviewed: 1,
    correct: 3,
    incorrect: 1,
  });
  expect(
    passes
      .list("original", true)
      .filter((pass) => pass.source === "deterministic")
      .at(-1)?.coverage.answered,
  ).toBe(4);
  expect(
    original.judgments.filter((judgment) => judgment.attemptId),
  ).toHaveLength(1);
});

it("uses all applied answers when a historical pass is selected before the next application", async () => {
  const { passes, service, db } = await fixture();
  const original = passes.list("original", true)[0]!;
  await service.apply({
    runId: "original",
    retryRunId: "retry",
    resultIds: ["a"],
    idempotencyKey: "first",
  });
  passes.select("original", original.id);
  await service.apply({
    runId: "original",
    retryRunId: "retry",
    resultIds: ["b"],
    idempotencyKey: "second",
  });
  const selected = passes.get(
    "original",
    db.require("run", "original").selectedAssessmentPassId!,
  );
  expect(selected.coverage.answered).toBe(3);
  expect(
    selected.judgments.find((judgment) => judgment.resultId === "a")?.attemptId,
  ).toBe("retry_attempt_a");
});

it("requires confirmation for replacements and preserves exact idempotent receipts across later changes", async () => {
  const { service, sources, db, addRetry } = await fixture();
  const first = await service.apply({
    runId: "original",
    retryRunId: "retry",
    resultIds: ["a"],
    idempotencyKey: "first",
  });
  await service.apply({
    runId: "original",
    retryRunId: "retry",
    resultIds: ["b"],
    idempotencyKey: "second",
  });
  const receipt = await service.apply({
    runId: "original",
    retryRunId: "retry",
    resultIds: ["a", "b"],
    idempotencyKey: "both-noop",
  });
  expect(receipt).toMatchObject({
    appliedResultIds: ["a", "b"],
    alreadyApplied: true,
  });
  addRetry("new-retry");
  await expect(
    service.apply({
      runId: "original",
      retryRunId: "new-retry",
      resultIds: ["a"],
      idempotencyKey: "replace",
    }),
  ).rejects.toThrow("Confirm replacement");
  await service.apply({
    runId: "original",
    retryRunId: "new-retry",
    resultIds: ["a"],
    idempotencyKey: "replace",
    replaceApplied: true,
  });
  expect(sources.source(db.require("result", "a"))?.runId).toBe("new-retry");
  expect(
    await service.apply({
      runId: "original",
      retryRunId: "retry",
      resultIds: ["a", "b"],
      idempotencyKey: "both-noop",
    }),
  ).toEqual(receipt);
  expect(
    (
      await service.apply({
        runId: "original",
        retryRunId: "retry",
        resultIds: ["a"],
        idempotencyKey: "first",
      })
    ).applicationId,
  ).toBe(first.applicationId);
  expect(sources.source(db.require("result", "a"))?.runId).toBe("new-retry");
});

it("rejects changed frozen configurations and mismatched repetitions", async () => {
  const { addRetry, service } = await fixture();
  addRetry("changed", true);
  await expect(
    service.apply({
      runId: "original",
      retryRunId: "changed",
      idempotencyKey: "changed",
    }),
  ).rejects.toThrow("different frozen configuration");
  addRetry("wrong-repetition", false, true);
  await expect(
    service.apply({
      runId: "original",
      retryRunId: "wrong-repetition",
      idempotencyKey: "wrong",
    }),
  ).rejects.toThrow("Select completed rerun answers");
});

it("seals application records and authorizes only explicitly adopted physical attempts", async () => {
  const { service, db, sources } = await fixture();
  const receipt = await service.apply({
    runId: "original",
    retryRunId: "retry",
    resultIds: ["a"],
    idempotencyKey: "apply",
  });
  const application = db.require("retryApplication", receipt.applicationId);
  expect(() =>
    db.update("retryApplication", { ...application, bindings: [] }),
  ).toThrow();
  expect(sources.authorize("original", "retry_attempt_a").result.id).toBe("a");
  expect(() => sources.authorize("original", "retry_attempt_b")).toThrow(
    "applied rerun",
  );
});

it("reads retry links and answer metadata without unrelated manifests or full attempt outputs", async () => {
  const { db, run, service, sources } = await fixture();
  db.insert("run", {
    ...run,
    id: "unrelated",
    manifest: {
      ...run.manifest,
      questions: [
        { id: "large", text: "private".repeat(10000), expected: 42, tags: [] },
      ],
    },
  });
  const list = db.list.bind(db),
    get = db.get.bind(db);
  const listSpy = vi.spyOn(db, "list").mockImplementation((kind, query) => {
    if (kind === "run" && !query?.parentRunId)
      throw new Error("Unscoped run read");
    return list(kind, query);
  });
  const getSpy = vi.spyOn(db, "get").mockImplementation((kind, recordId) => {
    if (kind === "attempt") throw new Error("Full attempt read");
    return get(kind, recordId);
  });
  try {
    const view = service.enrich({ run: { id: run.id } });
    expect(view.retryRuns.map((item) => item.runId)).toEqual(["retry"]);
    const results = sources.results(run.id);
    expect(
      results.find((result) => result.id === "ok")?.answerSource,
    ).toMatchObject({ runId: run.id, resultId: "ok", attemptId: "attempt_ok" });
  } finally {
    listSpy.mockRestore();
    getSpy.mockRestore();
  }
});

it("keeps compact score summaries identical to detailed passes and preserves selected retry provenance", async () => {
  const { db, passes, service } = await fixture();
  const summaries = passes.summaries("original");
  expect(summaries).toEqual(passes.list("original", true).map(summarizePass));
  await service.apply({
    runId: "original",
    retryRunId: "retry",
    resultIds: ["a"],
    idempotencyKey: "summary",
  });
  expect(passes.summaries("original")).toEqual(
    passes.list("original", true).map(summarizePass),
  );
  expect(db.runOutcomeCounts("original")).toEqual({
    total: 4,
    completed: 2,
    failed: 2,
  });
  const selected = db.require("run", "original").selectedAssessmentPassId;
  expect(
    passes.summaries("original").find((pass) => pass.id === selected)?.coverage
      .answered,
  ).toBe(2);
});

it.each(
  [
    true,
    false,
    null,
    "text",
    { type: "string", value: "x" },
    [true, null, "x"],
  ].map((expected) => ({ expected })),
)(
  "preserves reference types in compact score hashes: $expected",
  async ({ expected }) => {
    const { passes } = await fixture(expected);
    expect(passes.summaries("original")).toEqual(
      passes.list("original", true).map(summarizePass),
    );
  },
);

it.each(["running", "completed"] as const)(
  "matches detailed score coverage for exclusions, errors, abstentions, and Jev thresholds while %s",
  async (status) => {
    const { db, run, passes } = await fixture();
    const cases: Array<{
      id: string;
      deterministic: Verdict["status"];
      verdict: boolean | null;
      error?: boolean;
      choice: string;
      confidence: number;
      jevStatus?: "pending" | "error";
      exclude?: boolean;
      missing?: boolean;
    }> = [
      {
        id: "correct",
        deterministic: "correct",
        verdict: true,
        choice: "acceptable",
        confidence: 0.9,
      },
      {
        id: "incorrect",
        deterministic: "incorrect",
        verdict: false,
        choice: "incorrect",
        confidence: 0.9,
      },
      {
        id: "abstain",
        deterministic: "unavailable",
        verdict: null,
        choice: "acceptable",
        confidence: 0.5,
      },
      {
        id: "error",
        deterministic: "error",
        verdict: null,
        error: true,
        choice: "acceptable",
        confidence: 0.9,
        jevStatus: "error",
      },
      {
        id: "excluded",
        deterministic: "correct",
        verdict: true,
        choice: "acceptable",
        confidence: 0.9,
        exclude: true,
      },
      {
        id: "pending",
        deterministic: "correct",
        verdict: null,
        choice: "acceptable",
        confidence: 0.9,
        jevStatus: "pending",
        missing: true,
      },
      {
        id: "unscorable",
        deterministic: "unscorable",
        verdict: null,
        choice: "acceptable",
        confidence: 0.8,
      },
    ];
    const questions = cases.map((item) => ({
      id: item.id,
      text: item.id,
      expected: true,
      tags: [],
    }));
    const criteria = jevProfileSettingsSchema.parse({
      confidenceThreshold: 0.8,
    });
    const configuration = {
      model: "jev-test",
      connection: {
        connectionId: "c",
        provider: "typesafe" as const,
        settings: {},
        credentialFields: [],
      },
      profile: {
        id: "profile",
        bankId: "bank",
        number: 1,
        name: "Profile",
        createdAt: run.createdAt,
        settings: criteria,
        digest: "profile",
      },
    };
    const matrix: RunRecord = {
      ...run,
      id: "matrix",
      status,
      manifest: {
        ...run.manifest,
        questions,
        bank: { ...run.manifest.bank, questions },
        evaluator: {
          ...run.manifest.evaluator,
          settings: evaluatorSettingsSchema.parse({
            questionOverrides: {
              excluded: {
                referenceDisposition: "needs_review",
                referenceNote: "Reference remains disputed.",
              },
            },
          }),
        },
        judge: judgeSchema.parse({ enabled: true, agent: run.manifest.agent }),
        jevJudge: configuration,
      },
    };
    db.insert("run", matrix);
    for (const item of cases) {
      const resultId = `matrix_${item.id}`,
        attemptId = `attempt_${resultId}`;
      const output = { answer: true, text: "true" };
      db.insert("result", {
        id: resultId,
        runId: matrix.id,
        questionId: item.id,
        repetition: 1,
        status: "completed",
        attemptIds: [attemptId],
        completedAttemptId: attemptId,
      });
      db.insert("attempt", {
        id: attemptId,
        runId: matrix.id,
        resultId,
        number: 1,
        status: "completed",
        startedAt: run.createdAt,
        finishedAt: run.updatedAt,
        output,
        evidenceHash: digest(output),
      });
      if (!item.missing)
        db.insert("assessment", {
          id: `assessment_${resultId}`,
          runId: matrix.id,
          resultId,
          attemptId,
          deterministic: {
            status: item.deterministic,
            explanation: "Recorded",
          },
          ...(item.error
            ? { judgeError: "Failed", judgeResponse: { error: "provider" } }
            : { judge: { verdict: item.verdict, explanation: "Recorded" } }),
        });
      db.insert("jevAssessment", {
        id: `jev_${resultId}`,
        runId: matrix.id,
        resultId,
        attemptId,
        createdAt: run.createdAt,
        kind: "original",
        status: item.jevStatus ?? "completed",
        published: true,
        configuration,
        configurationHash: "configuration",
        evidenceHash: "evidence",
        attemptEvidenceHash: digest(output),
        bankRevisionId: matrix.manifest.bank.id,
        evaluatorRevisionId: matrix.manifest.evaluator.id,
        criteria,
        checks: {
          answer: {
            choice: item.choice,
            confidence: item.confidence,
            probabilities: { [item.choice]: item.confidence },
          },
        },
        evidence: {
          schemaVersion: 1,
          runId: matrix.id,
          resultId,
          attemptId,
          repetition: 1,
          question: { id: item.id, text: item.id, tags: [] },
          expected: true,
          finalAnswer: true,
          finalText: "true",
          startedAt: run.createdAt,
          finishedAt: run.updatedAt,
          referenceCriteria: {},
          trace: { format: "unavailable", entries: null },
        },
      });
    }
    const compact = passes.summaries(matrix.id);
    expect(compact).toEqual(passes.list(matrix.id, true).map(summarizePass));
    expect(
      compact.find((pass) => pass.source === "llm")?.coverage,
    ).toMatchObject({
      correct: 1,
      incorrect: 1,
      errors: 1,
      unjudged: 3,
      excluded: 1,
    });
    expect(
      compact.find((pass) => pass.source === "jev")?.coverage,
    ).toMatchObject({
      correct: 2,
      incorrect: 1,
      errors: 1,
      unjudged: 2,
      excluded: 1,
    });
  },
);
