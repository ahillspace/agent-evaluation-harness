import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentSchema,
  evaluatorSettingsSchema,
  judgeSchema,
  limitsSchema,
  researchSchema,
  jevProfileSettingsSchema,
  type BankRevision,
  type EvaluatorRevision,
  type RunRecord,
} from "../contracts.js";
import { Database } from "./database.js";

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
    expect(raw.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
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
    expect(after.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
    after.close();
  });
  it("projects score and researcher summaries without returning raw evidence", async () => {
    const db = await setup();
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
      kind: "original",
      published: true,
      assessments: [assessment],
    });
    const summaries = db.scoreSetSummaries("run1");
    expect(JSON.stringify(summaries)).not.toContain("private-evidence-");
    expect(
      summaries[0]?.assessments[0]?.deterministic.explanation,
    ).toHaveLength(300);
    expect(summaries[0]?.evaluator).not.toHaveProperty("settings");
    expect(db.assessmentSummaries("run1")[0]?.judge?.explanation).toHaveLength(
      300,
    );
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
      expect(raw.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
      raw.exec("PRAGMA user_version=4");
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
