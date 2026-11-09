import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createApplication } from "../../src/application/application.js";
import {
  agentSchema,
  evaluatorSettingsSchema,
  judgeSchema,
  limitsSchema,
  type BankRevision,
  type CommandResultMap,
  type RunRecord,
  type RuntimePort,
  type WorkspaceView,
} from "../../src/contracts.js";
import { digest } from "../../src/domain/identity.js";
import { startServer } from "../../src/server.js";
import { Database } from "../../src/storage/database.js";
import { targetFixture } from "../fixtures/runtime-targets.js";

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("refreshes mostly empty Runs without scanning unrelated completed answer bodies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeh-workspace-read-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "workspace.sqlite");
  const writer = new Database(filename);
  cleanups.push(() => writer.close());
  const createdAt = "2026-11-01T00:00:00.000Z";
  const bank: BankRevision = {
    id: "bank-revision",
    bankId: "bank",
    number: 1,
    name: "Repeated question",
    createdAt,
    questions: [{ id: "q1", text: "Answer?", expected: 42, tags: [] }],
    digest: "bank",
  };
  const evaluator = {
    id: "evaluator",
    bankId: bank.bankId,
    number: 1,
    name: "Evaluator",
    createdAt,
    settings: evaluatorSettingsSchema.parse({}),
    digest: "evaluator",
  };
  const subject: RunRecord = {
    id: "subject",
    name: "Mostly empty Run",
    createdAt,
    updatedAt: createdAt,
    status: "halted",
    intent: "halt",
    manifest: {
      bank,
      evaluator,
      agent: agentSchema.parse({ harness: "codex", model: "fixture" }),
      questions: bank.questions,
      repetitions: 65,
      judge: judgeSchema.parse({}),
      limits: limitsSchema.parse({}),
      digest: "manifest",
    },
  };
  const output = { answer: 42, text: "42" };
  const evidenceHash = digest(output);
  writer.insert("run", subject);
  for (let repetition = 1; repetition <= 65; repetition++) {
    const resultId = `subject-${repetition}`;
    const attemptId = `attempt-${resultId}`;
    writer.insert("result", {
      id: resultId,
      runId: subject.id,
      questionId: "q1",
      repetition,
      status:
        repetition === 1
          ? "completed"
          : repetition === 2
            ? "failed"
            : "pending",
      attemptIds: repetition <= 2 ? [attemptId] : [],
      ...(repetition === 1 ? { completedAttemptId: attemptId } : {}),
    });
    if (repetition <= 2)
      writer.insert("attempt", {
        id: attemptId,
        runId: subject.id,
        resultId,
        executionId: subject.id,
        number: 1,
        startedAt: createdAt,
        finishedAt: createdAt,
        status: repetition === 1 ? "completed" : "failed",
        ...(repetition === 1 ? { output, evidenceHash } : {}),
      });
  }
  writer.insert("assessment", {
    id: "assessment-subject",
    runId: subject.id,
    resultId: "subject-1",
    attemptId: "attempt-subject-1",
    deterministic: { status: "correct", explanation: "Recorded answer" },
  });
  const execute = vi.fn<RuntimePort["execute"]>(async () => {
    throw new Error("Unexpected target call");
  });
  const judge = vi.fn<RuntimePort["judge"]>(async () => {
    throw new Error("Unexpected judge call");
  });
  const researcher = vi.fn<RuntimePort["researcher"]>(async () => {
    throw new Error("Unexpected researcher call");
  });
  const runtime: RuntimePort = {
    ...targetFixture,
    resolveAgent: async (agent) => agent,
    recover: async () => ({ recovered: [], errors: [] }),
    close: async () => {},
    execute,
    judge,
    researcher,
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
  const application = await createApplication({
    dataDirectory: directory,
    runtime,
  });
  cleanups.push(() => application.close());
  const server = await startServer({ application, host: "127.0.0.1", port: 0 });
  cleanups.push(() => server.close());
  const reader = new DatabaseSync(filename, { readOnly: true });
  cleanups.push(() => reader.close());
  async function state() {
    const response = await fetch(`${server.url}/api/state`);
    expect(response.status).toBe(200);
    return (await response.json()) as WorkspaceView;
  }
  const small = (await state()).runs.find((run) => run.id === subject.id)!;
  expect(small).toMatchObject({
    completed: 1,
    failed: 1,
    total: 65,
    graded: 1,
    accuracy: 1,
  });
  expect(small.assessmentPasses?.[0]?.coverage).toEqual({
    eligible: 65,
    answered: 1,
    judged: 1,
    correct: 1,
    incorrect: 0,
    unjudged: 64,
    errors: 0,
    excluded: 0,
    reviewed: 0,
    overridden: 0,
  });

  // A sealed unrelated Run contributes large completed attempts to the global status index.
  const count = 256;
  const largeOutput = {
    answer: 42,
    text: "UNRELATED_PRIVATE_BODY" + "x".repeat(128 * 1024),
  };
  const largeHash = digest(largeOutput);
  const resultIds = Array.from(
    { length: count },
    (_, index) => `background-${index}`,
  );
  writer.transaction(() => {
    writer.insert("run", {
      ...subject,
      id: "background",
      name: "Sealed unrelated Run",
      status: "completed",
      manifest: { ...subject.manifest, repetitions: count },
    });
    for (const [index, resultId] of resultIds.entries()) {
      const attemptId = `attempt-${resultId}`;
      writer.insert("result", {
        id: resultId,
        runId: "background",
        questionId: "q1",
        repetition: index + 1,
        status: "completed",
        attemptIds: [attemptId],
        completedAttemptId: attemptId,
      });
      writer.insert("attempt", {
        id: attemptId,
        runId: "background",
        resultId,
        executionId: "background",
        number: 1,
        startedAt: createdAt,
        finishedAt: createdAt,
        status: "completed",
        output: largeOutput,
        evidenceHash: largeHash,
      });
    }
    writer.insert("assessmentPass", {
      id: "original_deterministic_background",
      runId: "background",
      name: "Original deterministic",
      source: "deterministic",
      status: "completed",
      createdAt,
      finishedAt: createdAt,
      configuration: { evaluator, referenceBank: bank },
      basis: {
        bankRevisionId: bank.id,
        evaluatorRevisionId: evaluator.id,
        referenceHash: digest([{ id: "q1", expected: 42 }]),
        eligibleResultIds: resultIds,
        excludedResultIds: [],
      },
      judgments: resultIds.map((resultId) => ({
        resultId,
        attemptId: `attempt-${resultId}`,
        evidenceHash: largeHash,
        status: "correct",
        explanation: "Recorded answer",
      })),
      coverage: {
        eligible: count,
        answered: count,
        judged: count,
        correct: count,
        incorrect: 0,
        unjudged: 0,
        errors: 0,
        excluded: 0,
        reviewed: 0,
        overridden: 0,
      },
      accuracy: 1,
      judgedAccuracy: 1,
    });
  });
  function savedStateHash() {
    const hash = createHash("sha256");
    for (const row of reader
      .prepare("SELECT kind,id,value FROM records ORDER BY ordinal")
      .iterate())
      hash.update(JSON.stringify(row));
    hash.update(
      JSON.stringify(
        reader.prepare("SELECT * FROM events ORDER BY sequence").all(),
      ),
    );
    return hash.digest("hex");
  }
  const before = savedStateHash();
  for (let poll = 0; poll < 2; poll++) {
    const started = performance.now();
    const refreshed = await state();
    const elapsed = performance.now() - started;
    // Setup and hashing stay outside a generous budget for an ordinary local refresh.
    expect(
      elapsed,
      "Workspace refresh with unrelated completed answers",
    ).toBeLessThan(3_000);
    expect(refreshed.totalRuns).toBe(2);
    expect(refreshed.runs.find((run) => run.id === subject.id)).toEqual(small);
    expect(JSON.stringify(refreshed)).not.toContain("UNRELATED_PRIVATE_BODY");
  }
  const response = await fetch(`${server.url}/api/commands/runs.observe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId: subject.id }),
  });
  expect(response.status).toBe(200);
  const observed = (await response.json()) as CommandResultMap["runs.observe"];
  const judgments = observed.assessmentPasses![0]!.judgments;
  expect(judgments.filter((judgment) => judgment.attemptId)).toEqual([
    {
      resultId: "subject-1",
      attemptId: "attempt-subject-1",
      evidenceHash,
      status: "correct",
      explanation: "Recorded answer",
    },
  ]);
  expect(savedStateHash()).toBe(before);
  expect(execute).not.toHaveBeenCalled();
  expect(judge).not.toHaveBeenCalled();
  expect(researcher).not.toHaveBeenCalled();
}, 60_000);
