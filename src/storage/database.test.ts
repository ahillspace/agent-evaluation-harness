import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPerformance } from "../application/performance.js";
import {
  attemptBudgetResearchSessionId,
  checkResearchBudget,
} from "../application/research-budget.js";
import {
  agentSchema,
  jsonSchema,
  evaluatorSettingsSchema,
  judgeSchema,
  limitsSchema,
  researchSchema,
  jevProfileSettingsSchema,
  type BankRevision,
  type EvaluatorRevision,
  type RunRecord,
  type AttemptRecord,
  type ResultRecord,
  type JevAssessmentRecord,
} from "../contracts.js";
import { Database } from "./database.js";
import { digest } from "../domain/identity.js";
import { AnswerSources } from "../application/answer-sources.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "aeh-storage-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const db = new Database(join(directory, "catalog.sqlite"));
  cleanups.push(async () => db.close());
  return db;
}

const bank: BankRevision = {
  id: "bankrev1",
  bankId: "bank1",
  number: 1,
  createdAt: "2026-10-03T00:00:00Z",
  name: "Bank",
  questions: [{ id: "q1", text: "Question", expected: 42, tags: [] }],
  digest: "bank-digest",
};
const evaluator: EvaluatorRevision = {
  id: "eval1",
  bankId: "bank1",
  number: 1,
  createdAt: bank.createdAt,
  name: "Default",
  settings: evaluatorSettingsSchema.parse({}),
  digest: "evaluator-digest",
};
function run(id: string): RunRecord {
  return {
    id,
    name: id,
    createdAt: bank.createdAt,
    updatedAt: bank.createdAt,
    status: "queued",
    intent: "run",
    manifest: {
      bank,
      evaluator,
      agent: agentSchema.parse({ harness: "codex", model: "fixture" }),
      questions: bank.questions,
      repetitions: 1,
      judge: judgeSchema.parse({}),
      limits: limitsSchema.parse({}),
      digest: "manifest-digest",
    },
  };
}

describe("typed durable records", () => {
  it.each<[string, string[], string | undefined, string[] | undefined]>([
    ["empty slots", [], undefined, undefined],
    [
      "incomplete attempts",
      ["failed", "interrupted", "running"],
      undefined,
      undefined,
    ],
    ["later executions", ["later"], undefined, undefined],
    ["legacy execution attribution", ["legacy"], "legacy", undefined],
    [
      "newest eligible attempt",
      ["original-old", "original-new", "later", "failed"],
      "original-new",
      undefined,
    ],
    [
      "array order",
      ["original-new", "original-old"],
      "original-old",
      undefined,
    ],
    ["frozen missing answers", ["original-new"], undefined, []],
    [
      "first captured duplicate",
      ["original-new"],
      "original-old",
      ["original-old", "original-new", "original-old"],
    ],
  ])(
    "projects the exact first-execution binding for %s",
    async (_name, attemptIds, expectedAttemptId, capturedIds) => {
      const db = await setup();
      db.insert("run", run("logical"));
      const result: ResultRecord = {
        id: "result",
        runId: "logical",
        questionId: "q1",
        repetition: 1,
        status: "interrupted",
        attemptIds,
      };
      db.insert("result", result);
      const output = { answer: 42, text: "42" };
      const evidenceHash = digest(output);
      const candidates: Array<
        Pick<AttemptRecord, "id" | "status" | "executionId">
      > = [
        { id: "original-old", status: "completed", executionId: "logical" },
        { id: "original-new", status: "completed", executionId: "logical" },
        { id: "legacy", status: "completed" },
        { id: "later", status: "completed", executionId: "recovery" },
        { id: "failed", status: "failed" },
        { id: "interrupted", status: "interrupted" },
        { id: "running", status: "running" },
      ];
      for (const [index, candidate] of candidates.entries())
        db.insert("attempt", {
          ...candidate,
          runId: "logical",
          resultId: result.id,
          number: index + 1,
          startedAt: bank.createdAt,
          finishedAt: bank.createdAt,
          ...(candidate.status === "completed" ? { output, evidenceHash } : {}),
        });
      const assessments = capturedIds?.map((attemptId, index) => ({
        resultId: result.id,
        attemptId,
        deterministic: {
          status: "correct" as const,
          explanation: `Captured ${index}`,
        },
      }));
      if (assessments)
        db.insert("scoreSet", {
          id: "original-score",
          runId: "logical",
          evaluator,
          createdAt: bank.createdAt,
          kind: "original",
          published: true,
          assessments,
        });
      expect(db.automaticAssessmentInputs("logical", true)).toEqual([
        {
          result,
          ...(expectedAttemptId
            ? {
                attemptId: expectedAttemptId,
                source: {
                  runId: "logical",
                  resultId: result.id,
                  attemptId: expectedAttemptId,
                  evidenceHash,
                },
                attempt: {
                  runId: "logical",
                  resultId: result.id,
                  status: "completed",
                  finishedAt: bank.createdAt,
                  evidenceHash,
                  hasOutput: true,
                },
                owner: { runId: "logical", questionId: "q1", repetition: 1 },
                sourceRun: { id: "logical", retryOf: null, sameManifest: true },
                ...(assessments
                  ? {
                      raw: {
                        scoreSetId: "original-score",
                        assessment: assessments[0],
                        judgeResponded: false,
                      },
                    }
                  : {}),
              }
            : {}),
        },
      ]);
    },
  );
  it("compares adopted frozen manifests structurally without parsing configurations or evidence bodies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aeh-structural-source-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const filename = join(directory, "workspace.sqlite");
    const db = new Database(filename);
    cleanups.push(async () => db.close());
    const parent = run("logical");
    parent.manifest.agent!.systemPrompt = "PRIVATE_CONFIG".repeat(5000);
    db.insert("run", parent);
    const physical = {
      ...parent,
      id: "physical",
      retryOf: { runId: parent.id, resultIds: ["logical-result"] },
    };
    const writer = new DatabaseSync(filename);
    try {
      // Historical serializers can use a different object order and numeric spelling.
      writer
        .prepare("INSERT INTO records(kind,id,value) VALUES ('run',?,?)")
        .run(
          physical.id,
          JSON.stringify(physical).replace(
            '"repetitions":1',
            '"repetitions":1.0',
          ),
        );
    } finally {
      writer.close();
    }
    const output = { answer: 42, text: "PRIVATE_OUTPUT".repeat(20_000) };
    db.insert("result", {
      id: "logical-result",
      runId: parent.id,
      questionId: "q1",
      repetition: 1,
      status: "failed",
      attemptIds: [],
    });
    db.insert("result", {
      id: "physical-result",
      runId: physical.id,
      questionId: "q1",
      repetition: 1,
      status: "completed",
      completedAttemptId: "physical-attempt",
      attemptIds: ["physical-attempt"],
    });
    db.insert("attempt", {
      id: "physical-attempt",
      runId: physical.id,
      resultId: "physical-result",
      number: 1,
      startedAt: bank.createdAt,
      finishedAt: bank.createdAt,
      status: "completed",
      output,
      evidenceHash: digest(output),
    });
    const source = db.answerSource("physical-attempt");
    db.insert("retryApplication", {
      id: "historical-binding",
      runId: parent.id,
      retryRunId: physical.id,
      createdAt: bank.createdAt,
      bindings: [{ resultId: "logical-result", source }],
      assessmentPassIds: [],
    });
    const parse = JSON.parse;
    const bodies: string[] = [];
    const parseSpy = vi
      .spyOn(JSON, "parse")
      .mockImplementation((text, reviver) => {
        if (text.includes("PRIVATE_CONFIG") || text.includes("PRIVATE_OUTPUT"))
          bodies.push("full body");
        return parse(text, reviver);
      });
    let metadata;
    try {
      metadata = db.automaticAssessmentInputs(parent.id, false)[0]!;
      expect(metadata.sourceRun?.sameManifest).toBe(true);
      expect(metadata.source).toEqual(source);
      expect(bodies).toEqual([]);
    } finally {
      parseSpy.mockRestore();
    }
    expect(
      new AnswerSources(db).verify(metadata.result, metadata.source!).id,
    ).toBe("physical-attempt");
  });
  it("uses frozen attempt attribution for research budgets and treats new standalone usage as separate", async () => {
    const db = await setup();
    const timestamp = new Date().toISOString();
    const configuration = researchSchema.parse({
      baseline: {
        bankRevisionId: bank.id,
        agent: { harness: "codex", model: "fixture" },
      },
      researcher: { harness: "codex", model: "fixture" },
      objective: "Fixture objective",
      maxTargetInvocations: 1,
      maxTotalTokens: 100,
    });
    const session = db.insert("research", {
      id: "budget-session",
      name: "Budget fixture",
      createdAt: timestamp,
      updatedAt: timestamp,
      status: "completed",
      intent: "run",
      configuration,
      baselineRunId: "budget-run",
      currentRunId: "budget-run",
      bestRunId: "budget-run",
      runIds: ["budget-run"],
      phase: "finished",
      turns: [],
    });
    db.insert("run", { ...run("budget-run"), researchSessionId: session.id });
    const legacy = db.insert("attempt", {
      id: "legacy-budget-attempt",
      runId: "budget-run",
      resultId: "q",
      number: 1,
      startedAt: timestamp,
      status: "failed",
      failure: {
        code: "fixture",
        classification: {
          category: "unknown",
          transient: false,
          retrySafety: "unknown",
          usage: { inputTokens: 10, outputTokens: 10 },
        },
      },
    });
    const standalone = db.insert("attempt", {
      id: "standalone-attempt",
      runId: "budget-run",
      resultId: "q",
      number: 2,
      executionId: "standalone-execution",
      startedAt: timestamp,
      status: "failed",
    });
    expect(attemptBudgetResearchSessionId(db, legacy)).toBe(session.id);
    expect(attemptBudgetResearchSessionId(db, standalone)).toBeUndefined();
    expect(checkResearchBudget(db, session)).toBeUndefined();
    expect(checkResearchBudget(db, session, 1)).toContain("invocation budget");
  });
  it("keeps admitted attempt execution and budget attribution immutable", async () => {
    const db = await setup();
    const attempt = db.insert("attempt", {
      id: "attributed",
      runId: "r",
      resultId: "q",
      number: 1,
      startedAt: bank.createdAt,
      status: "running",
      executionId: "execution-a",
      budgetResearchSessionId: "research-a",
    });
    expect(() =>
      db.update("attempt", { ...attempt, executionId: "execution-b" }),
    ).toThrow(/immutable/i);
    expect(() =>
      db.update("attempt", { ...attempt, budgetResearchSessionId: undefined }),
    ).toThrow(/immutable/i);
    expect(db.require("attempt", attempt.id)).toEqual(attempt);
  });
  it("measures active execution segments without paused idle time and preserves incomplete timing", async () => {
    const db = await setup();
    const record = run("timed");
    const segmentStart = Date.parse(bank.createdAt);
    const clock = vi.spyOn(Date, "now").mockReturnValue(segmentStart + 500);
    try {
      const active = db.insert("run", {
        ...record,
        status: "running",
        activeDurationMs: 120,
        execution: {
          id: record.id,
          resultIds: [],
          controller: "run",
          createdAt: bank.createdAt,
          activeSegmentStartedAt: bank.createdAt,
        },
      });
      expect(runPerformance(db, record.id).durationMs).toBe(620);
      const paused = db.update("run", {
        ...active,
        status: "paused",
        activeDurationMs: 620,
        execution: { ...active.execution!, activeSegmentStartedAt: undefined },
      });
      clock.mockReturnValue(segmentStart + 100000);
      expect(runPerformance(db, record.id).durationMs).toBe(620);
      db.update("run", { ...paused, activeDurationIncomplete: true });
      expect(runPerformance(db, record.id)).toMatchObject({
        durationMs: null,
        durationIncomplete: true,
      });
    } finally {
      clock.mockRestore();
    }
  });
  it("keeps fallback payloads out of observation while retaining per-call usage", async () => {
    const db = await setup();
    const criteria = jevProfileSettingsSchema.parse({ answerOnlyFallback: {} });
    const record: JevAssessmentRecord = {
      id: "ja",
      runId: "r",
      resultId: "q",
      attemptId: "a",
      createdAt: bank.createdAt,
      status: "completed",
      kind: "original",
      published: true,
      configuration: {
        model: "jev-1.13.0",
        connection: {
          connectionId: "c",
          provider: "typesafe",
          settings: {},
          credentialFields: [],
        },
        profile: {
          id: "p",
          bankId: "bank1",
          number: 1,
          name: "Trace checks",
          createdAt: bank.createdAt,
          digest: "p",
          settings: criteria,
        },
      },
      configurationHash: "config",
      evidenceHash: "evidence",
      attemptEvidenceHash: "attempt",
      bankRevisionId: bank.id,
      evaluatorRevisionId: evaluator.id,
      evidence: {
        schemaVersion: 1,
        runId: "r",
        resultId: "q",
        attemptId: "a",
        repetition: 1,
        referenceCriteria: {},
        finalText: "42",
        question: bank.questions[0]!,
        expected: 42,
        finalAnswer: 42,
        publicAgent: agentSchema.parse({ harness: "codex", model: "fixture" }),
        startedAt: bank.createdAt,
        finishedAt: bank.createdAt,
        trace: { format: "unavailable", entries: null },
      },
      criteria,
      fallback: {
        trigger: {
          error: { code: "token_limit_exceeded", message: "Too large" },
          request: { large: "PRIVATE_TRACE" },
          response: { detail: "PRIVATE_RESPONSE" },
          usage: { inputTokens: 10 },
        },
        criteria: criteria.answerOnlyFallback!,
        resultUsage: { inputTokens: 20 },
      },
      usage: { inputTokens: 30 },
    };
    db.insert("jevAssessment", record);
    const [summary] = db.jevSummaries("r");
    expect(summary).toMatchObject({
      fallbackApplied: true,
      fallbackUsage: { inputTokens: 10 },
      fallbackResultUsage: { inputTokens: 20 },
      usage: { inputTokens: 30 },
    });
    expect(summary).not.toHaveProperty("fallback");
    expect(JSON.stringify(summary)).not.toContain("PRIVATE_");
    expect(db.require("jevAssessment", "ja").fallback).toEqual(record.fallback);
    db.insert("jevAssessment", { ...record, id: "plain", fallback: undefined });
    const withoutFallback = db
      .jevSummaries("r")
      .find((item) => item.id === "plain");
    expect(withoutFallback?.fallbackApplied).toBe(false);
    expect(withoutFallback).not.toHaveProperty("fallbackUsage");
    expect(withoutFallback).not.toHaveProperty("fallbackResultUsage");
  });
  it("freezes canonical target configuration in blueprints", async () => {
    const db = await setup();
    const blueprint = db.insert("blueprint", {
      id: "external",
      name: "Endpoint",
      createdAt: bank.createdAt,
      target: {
        kind: "external",
        adapterId: "http",
        adapterVersion: 1,
        name: "Endpoint",
        configuration: { endpoint: "https://example.com" },
      },
      repetitions: 1,
      limits: limitsSchema.parse({}),
      judge: judgeSchema.parse({}),
    });
    expect(() =>
      db.update("blueprint", {
        ...blueprint,
        agent: undefined,
        target: {
          kind: "external",
          adapterId: "http",
          adapterVersion: 1,
          name: "Changed",
          configuration: {},
        },
      }),
    ).toThrow("immutable");
  });
  it("migrates version 1 catalogs without changing evidence or idempotency records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aeh-migration-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const filename = join(directory, "catalog.sqlite");
    const old = new DatabaseSync(filename);
    old.exec(`CREATE TABLE records(kind TEXT NOT NULL CHECK(kind IN ('run')),id TEXT NOT NULL,value TEXT NOT NULL,immutable INTEGER NOT NULL DEFAULT 0,ordinal INTEGER PRIMARY KEY AUTOINCREMENT,UNIQUE(kind,id));
      CREATE TABLE idempotency(key TEXT PRIMARY KEY, hash TEXT NOT NULL, kind TEXT NOT NULL,record_id TEXT NOT NULL,FOREIGN KEY(kind,record_id) REFERENCES records(kind,id)); PRAGMA user_version=1;`);
    const original = JSON.stringify(run("old"));
    old
      .prepare("INSERT INTO records(kind,id,value) VALUES('run','old',?)")
      .run(original);
    old.exec("INSERT INTO idempotency VALUES('old-key','hash','run','old')");
    old.close();
    const db = new Database(filename);
    cleanups.push(async () => db.close());
    expect(db.require("run", "old")).toEqual(run("old"));
    expect(db.idempotent("old-key", "hash")).toEqual({
      kind: "run",
      id: "old",
    });
    const revision = db.insert("jevProfile", {
      id: "jp1",
      bankId: "bank1",
      number: 1,
      name: "Jev",
      createdAt: bank.createdAt,
      settings: jevProfileSettingsSchema.parse({}),
      digest: "digest",
    });
    expect(() =>
      db.update("jevProfile", { ...revision, name: "Changed" }),
    ).toThrow();
    const raw = new DatabaseSync(filename);
    expect(
      raw.prepare("SELECT value FROM records WHERE id='old'").get()?.value,
    ).toBe(original);
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(raw.prepare("PRAGMA user_version").get()?.user_version).toBe(7);
    raw.close();
  });
  it("preserves version 2 record bytes while installing target immutability", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aeh-target-migration-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const filename = join(directory, "catalog.sqlite");
    const seed = new Database(filename);
    seed.insert("run", run("legacy"));
    seed.close();
    const raw = new DatabaseSync(filename);
    raw.exec("PRAGMA user_version=2");
    const before = raw
      .prepare("SELECT value FROM records WHERE id='legacy'")
      .get()?.value;
    raw.close();
    const upgraded = new Database(filename);
    expect(upgraded.require("run", "legacy").manifest).toHaveProperty("agent");
    upgraded.close();
    const after = new DatabaseSync(filename);
    expect(
      after.prepare("SELECT value FROM records WHERE id='legacy'").get()?.value,
    ).toBe(before);
    expect(after.prepare("PRAGMA user_version").get()?.user_version).toBe(7);
    after.close();
  });
  it("projects score and researcher summaries without returning raw evidence", async () => {
    const db = await setup();
    db.insert("run", run("run1"));
    const payload = "private-evidence-" + "x".repeat(100_000);
    const assessment = {
      resultId: "result1",
      attemptId: "attempt1",
      deterministic: {
        status: "correct" as const,
        explanation: "e".repeat(1000),
        details: { payload },
      },
      judge: {
        verdict: true,
        explanation: "j".repeat(1000),
        custom: { payload },
      },
    };
    db.insert("assessment", {
      ...assessment,
      id: "assessment1",
      runId: "run1",
    });
    db.insert("scoreSet", {
      id: "scores1",
      runId: "run1",
      evaluator,
      createdAt: bank.createdAt,
      kind: "rescore",
      published: true,
      assessments: [assessment],
    });
    const summaries = db.legacyScoreSummaryInputs("run1");
    expect(JSON.stringify(summaries)).not.toContain("private-evidence-");
    expect(summaries[0]?.assessments[0]?.deterministic).toBe("correct");
    expect(summaries[0]).not.toHaveProperty("evaluator");
    const output = { answer: 42, text: payload };
    db.insert("result", {
      id: "result1",
      runId: "run1",
      questionId: "q1",
      repetition: 1,
      status: "completed",
      completedAttemptId: "attempt1",
      attemptIds: ["attempt1"],
    });
    db.insert("attempt", {
      id: "attempt1",
      runId: "run1",
      resultId: "result1",
      status: "completed",
      number: 1,
      startedAt: bank.createdAt,
      finishedAt: bank.createdAt,
      output,
      evidenceHash: digest(output),
    });
    const automatic = db.automaticAssessmentInputs("run1", true);
    expect(automatic[0]?.raw?.assessment.judge?.verdict).toBe(true);
    expect(JSON.stringify(automatic)).not.toContain("private-evidence-");
    expect(
      db.attemptAssessments("run1", "attempt1")[0]?.assessment.deterministic
        .details,
    ).toEqual({ payload });
    const configuration = researchSchema.parse({
      baseline: { bankRevisionId: bank.id, agent: run("run1").manifest.agent },
      researcher: run("run1").manifest.agent,
      objective: "Improve accuracy",
    });
    db.insert("research", {
      id: "research1",
      name: "Research",
      createdAt: bank.createdAt,
      updatedAt: bank.createdAt,
      status: "completed",
      intent: "run",
      configuration,
      baselineRunId: "run1",
      currentRunId: "run1",
      bestRunId: "run1",
      runIds: ["run1"],
      phase: "finished",
      pendingTurn: { input: payload, startedAt: bank.createdAt },
      turns: [
        {
          input: payload,
          createdAt: bank.createdAt,
          output: {
            conversationId: "provider",
            message: "m".repeat(5000),
            transcript: { payload },
            decision: "stop",
          },
        },
      ],
    });
    const summary = db.researchSummary("research1");
    expect(JSON.stringify(summary)).not.toContain("private-evidence-");
    expect(summary.turns[0]?.output.message).toHaveLength(1000);
    expect(summary.turns[0]?.output.decision).toBe("stop");
    expect(
      db.require("research", "research1").turns[0]?.output.transcript,
    ).toEqual({ payload });
  });
  it("projects observation metadata without loading sealed answer payloads", async () => {
    const db = await setup();
    db.insert("attempt", {
      id: "attempt1",
      runId: "run1",
      resultId: "result1",
      number: 1,
      startedAt: bank.createdAt,
      status: "completed",
      output: {
        answer: 42,
        text: "private-detail-marker",
        transcript: [{ text: "large-transcript-marker" }],
        usage: { inputTokens: 10, outputTokens: 2 },
      },
    });
    const summaries = db.attemptSummaries("run1");
    expect(summaries[0]?.usage?.inputTokens).toBe(10);
    expect(summaries[0]?.hasOutput).toBe(true);
    expect(JSON.stringify(summaries)).not.toContain("marker");
    db.append({
      runId: "run1",
      attemptId: "attempt1",
      type: "tool.completed",
      message: "x".repeat(2000),
      data: { detail: "full-event-marker" },
    });
    db.append({
      runId: "run1",
      attemptId: "attempt2",
      type: "tool.completed",
      message: "Other attempt",
    });
    const events = db.events({ runId: "run1" }, 0, { limit: 1, summary: true });
    expect(events).toHaveLength(1);
    expect(events[0]?.message.length).toBe(1000);
    expect(events[0]?.data).toBeUndefined();
    const full = db.events({ runId: "run1", attemptId: "attempt1" });
    expect(full).toHaveLength(1);
    expect(full[0]?.data).toEqual({ detail: "full-event-marker" });
  });
  it("records its schema version and refuses a newer catalog", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aeh-schema-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "catalog.sqlite");
    new Database(path).close();
    const raw = new DatabaseSync(path);
    try {
      expect(raw.prepare("PRAGMA user_version").get()?.user_version).toBe(7);
      raw.exec("PRAGMA user_version=8");
    } finally {
      raw.close();
    }
    expect(() => new Database(path)).toThrow("newer application");
  });
  it("protects published revisions even when a caller omits the immutable flag", async () => {
    const db = await setup();
    db.insert("bankRevision", bank);
    db.insert("evaluator", evaluator);
    expect(() =>
      db.update("bankRevision", { ...bank, name: "Changed" }),
    ).toThrow();
    expect(() =>
      db.update("evaluator", { ...evaluator, name: "Changed" }),
    ).toThrow();
  });

  it("allows lifecycle changes while freezing manifests and completed evidence", async () => {
    const db = await setup();
    const initial = run("run1");
    db.insert("run", initial);
    db.update("run", { ...initial, status: "running" });
    expect(() =>
      db.update("run", {
        ...initial,
        manifest: { ...initial.manifest, repetitions: 2 },
      }),
    ).toThrow();
    const attempt = {
      id: "attempt1",
      runId: initial.id,
      resultId: "result1",
      number: 1,
      startedAt: bank.createdAt,
      status: "completed" as const,
      output: { answer: 42, text: "42" },
      evidenceHash: "sealed",
    };
    db.insert("attempt", attempt);
    expect(() =>
      db.update("attempt", { ...attempt, output: { answer: 43, text: "43" } }),
    ).toThrow();
    expect(db.require("attempt", attempt.id).output?.answer).toBe(42);
  });

  it("filters and paginates records in storage without loading unrelated runs", async () => {
    const db = await setup();
    for (let index = 0; index < 6; index++) {
      db.insert("result", {
        id: `result${index}`,
        runId: index < 4 ? "run1" : "run2",
        questionId: "q1",
        repetition: index + 1,
        status: index % 2 ? "completed" : "pending",
        attemptIds: [],
      });
    }
    expect(
      db
        .list("result", { runId: "run1", limit: 2, offset: 1 })
        .map((row) => row.id),
    ).toEqual(["result1", "result2"]);
    expect(
      db
        .list("result", { runId: "run1", status: ["pending"] })
        .map((row) => row.id),
    ).toEqual(["result0", "result2"]);
    expect(
      db
        .list("result", { runId: "run2", descending: true })
        .map((row) => row.id),
    ).toEqual(["result5", "result4"]);
    expect(db.count("result")).toBe(6);
    expect(db.count("result", { runId: "run1", status: "pending" })).toBe(2);
    expect(db.count("result", { runId: [] })).toBe(0);
  });

  it("rolls back records and idempotency together when a command fails", async () => {
    const db = await setup();
    expect(() =>
      db.transaction(() => {
        db.insert("run", run("run1"));
        db.remember("launch", "digest", "run", "run1");
        throw new Error("Failed command");
      }),
    ).toThrow("Failed command");
    expect(db.get("run", "run1")).toBeUndefined();
    expect(db.idempotent("launch", "digest")).toBeUndefined();
  });
});

it("projects known usage from failed attempts without inventing zero usage", async () => {
  const db = await setup();
  db.insert("attempt", {
    id: "failed",
    runId: "run",
    resultId: "result",
    number: 1,
    startedAt: bank.createdAt,
    status: "failed",
    failure: {
      code: "target_failure",
      classification: {
        category: "rate-limit",
        transient: true,
        retrySafety: "unknown",
        usage: { inputTokens: 12, outputTokens: 3 },
      },
    },
  });
  expect(db.attemptSummaries("run")[0]?.usage).toEqual({
    inputTokens: 12,
    outputTokens: 3,
  });
});

it("keeps an opaque workspace identity across reopening and catalog changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeh-identity-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "catalog.sqlite"),
    first = new Database(file);
  const identity = first.workspaceId();
  first.insert("bankRevision", bank);
  first.close();
  const reopened = new Database(file),
    other = new Database(join(directory, "other.sqlite"));
  try {
    expect(reopened.workspaceId()).toBe(identity);
    expect(other.workspaceId()).not.toBe(identity);
    expect(identity).toMatch(/^workspace_/);
  } finally {
    reopened.close();
    other.close();
  }
});
it("projects original judge requests as pending until their assessment is recorded", async () => {
  const db = await setup();
  db.append({
    runId: "run",
    attemptId: "attempt",
    type: "judge.request",
    message: "Requested",
    data: {},
  });
  expect(db.originalJudgeUsage("run")).toEqual([{ pending: true }]);
  db.insert("assessment", {
    id: "assessment",
    runId: "run",
    resultId: "result",
    attemptId: "attempt",
    deterministic: { status: "correct", explanation: "Matched" },
    judge: { verdict: true, usage: { inputTokens: 5, outputTokens: 2 } },
  });
  expect(db.originalJudgeUsage("run")).toEqual([
    { pending: false, usage: { inputTokens: 5, outputTokens: 2 } },
  ]);
});

it("distinguishes a pending saved judgment from completed abstentions with unreported usage", async () => {
  const db = await setup();
  db.insert("assessmentPass", {
    id: "pass",
    runId: "run",
    name: "Judge",
    source: "llm",
    status: "running",
    createdAt: bank.createdAt,
    basis: {
      bankRevisionId: bank.id,
      evaluatorRevisionId: evaluator.id,
      eligibleResultIds: ["r1", "r2", "r3"],
      excludedResultIds: [],
      referenceHash: "hash",
    },
    configuration: {},
    judgments: [
      {
        resultId: "r1",
        judgmentId: "j1",
        status: "unjudged",
        explanation: "Abstained",
        response: { verdict: null },
      },
      {
        resultId: "r2",
        judgmentId: "j2",
        status: "unjudged",
        explanation: "Pending",
        request: {},
      },
      {
        resultId: "r3",
        judgmentId: "j3",
        status: "correct",
        explanation: "Correct",
      },
    ],
    coverage: {
      eligible: 3,
      answered: 3,
      judged: 1,
      correct: 1,
      incorrect: 0,
      unjudged: 2,
      errors: 0,
      excluded: 0,
      reviewed: 0,
      overridden: 0,
    },
    accuracy: 1,
    judgedAccuracy: 1,
  });
  expect(db.passJudgeUsage("run")).toEqual([
    { judgmentId: "j1", pending: false },
    { judgmentId: "j2", pending: true },
    { judgmentId: "j3", pending: false },
  ]);
});
it("recovers only matching sealed usage breakdowns and caches settled projections", async () => {
  const db = await setup();
  db.insert("run", run("usage-run"));
  for (const [id, raw] of Object.entries({
    good: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 60 },
    mismatch: { input_tokens: 101, output_tokens: 20, cached_input_tokens: 60 },
    malformed: {
      input_tokens: 100,
      output_tokens: 20,
      cached_input_tokens: 200,
    },
    absent: { input_tokens: 100, output_tokens: 20 },
  })) {
    db.insert("attempt", {
      id,
      runId: "usage-run",
      resultId: id,
      number: 1,
      startedAt: bank.createdAt,
      status: "completed",
      output: {
        answer: 42,
        text: "42",
        usage: { inputTokens: 100, outputTokens: 20 },
      },
    });
    db.append({
      runId: "usage-run",
      attemptId: id,
      type: "usage",
      message: "Usage",
      data: jsonSchema.parse(raw),
    });
  }
  for (const id of ["no-events", "duplicate"]) {
    db.insert("attempt", {
      id,
      runId: "usage-run",
      resultId: id,
      number: 1,
      startedAt: bank.createdAt,
      status: "completed",
      output: {
        answer: 42,
        text: "42",
        usage: { inputTokens: 100, outputTokens: 20 },
      },
    });
  }
  for (let i = 0; i < 2; i++)
    db.append({
      runId: "usage-run",
      attemptId: "duplicate",
      type: "usage",
      message: "Usage",
      data: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 60 },
    });
  const { UsageProjection } =
    await import("../application/usage-projection.js");
  const { HarnessUsage } = await import("../runtime/usage.js");
  let calls = 0;
  const projection = new UsageProjection(db, (harness, events) => {
    calls++;
    const usage = new HarnessUsage(harness);
    for (const event of events) usage.add(event);
    return usage.value();
  });
  expect(
    projection.attempts("usage-run").map((a) => a.usage?.uncachedInputTokens),
  ).toEqual([40, undefined, undefined, undefined, undefined, undefined]);
  projection.attempts("usage-run");
  expect(calls).toBe(6);
  expect(db.require("attempt", "good").output?.usage).toEqual({
    inputTokens: 100,
    outputTokens: 20,
  });
});

it("bounds historical usage event projection and excludes unrelated large events", async () => {
  const db = await setup();
  db.append({
    runId: "run",
    attemptId: "attempt",
    type: "message",
    message: "Large transcript",
    data: { text: "x".repeat(20000) },
  });
  db.append({
    runId: "run",
    attemptId: "attempt",
    type: "usage",
    message: "Usage",
    data: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 60 },
  });
  expect(db.attemptUsageEvents("attempt")).toEqual([
    { input_tokens: 100, output_tokens: 20, cached_input_tokens: 60 },
  ]);
  db.append({
    runId: "run",
    attemptId: "attempt",
    type: "usage",
    message: "Oversized",
    data: { text: "x".repeat(1048576) },
  });
  expect(db.attemptUsageEvents("attempt")).toBeUndefined();
});

it("migrates version 6 retry and bank indexes without rewriting record bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeh-index-migration-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "catalog.sqlite");
  const bytes = JSON.stringify(
    { ...run("retry"), retryOf: { runId: "parent", resultIds: ["r"] } },
    null,
    2,
  );
  const raw = new DatabaseSync(filename);
  try {
    raw.exec(
      "PRAGMA foreign_keys=OFF; CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,immutable INTEGER NOT NULL DEFAULT 0,ordinal INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT GENERATED ALWAYS AS (json_extract(value,'$.runId')) VIRTUAL,result_id TEXT GENERATED ALWAYS AS (json_extract(value,'$.resultId')) VIRTUAL,bank_id TEXT GENERATED ALWAYS AS (json_extract(value,'$.bankId')) VIRTUAL,session_id TEXT GENERATED ALWAYS AS (json_extract(value,'$.researchSessionId')) VIRTUAL,status TEXT GENERATED ALWAYS AS (json_extract(value,'$.status')) VIRTUAL,UNIQUE(kind,id)); PRAGMA user_version=6;",
    );
    raw.exec(
      "CREATE TABLE idempotency(key TEXT PRIMARY KEY,hash TEXT NOT NULL,kind TEXT NOT NULL,record_id TEXT NOT NULL,response TEXT,FOREIGN KEY(kind,record_id) REFERENCES records(kind,id)); INSERT INTO idempotency VALUES('orphan','hash','run','missing',NULL);",
    );
    raw
      .prepare("INSERT INTO records(kind,id,value) VALUES('run','retry',?)")
      .run(bytes);
  } finally {
    raw.close();
  }
  expect(() => new Database(filename)).toThrow("migration validation");
  const recovery = new DatabaseSync(filename);
  try {
    expect(recovery.prepare("PRAGMA user_version").get()?.user_version).toBe(6);
    expect(
      recovery
        .prepare("PRAGMA table_xinfo(records)")
        .all()
        .some((column) => column.name === "parent_run_id"),
    ).toBe(false);
    expect(
      recovery.prepare("SELECT value FROM records WHERE id='retry'").get()
        ?.value,
    ).toBe(bytes);
    recovery.exec("DELETE FROM idempotency WHERE key='orphan'");
  } finally {
    recovery.close();
  }
  const db = new Database(filename);
  try {
    expect(
      db.list("run", { parentRunId: "parent" }).map((item) => item.id),
    ).toEqual(["retry"]);
    expect(
      db.runPage({ bankId: bank.bankId, search: "retry", limit: 1, offset: 0 })
        .total,
    ).toBe(1);
  } finally {
    db.close();
  }
  const after = new DatabaseSync(filename);
  try {
    expect(
      after.prepare("SELECT value FROM records WHERE id='retry'").get()?.value,
    ).toBe(bytes);
    expect(after.prepare("PRAGMA user_version").get()?.user_version).toBe(7);
    expect(after.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    after.close();
  }
});
