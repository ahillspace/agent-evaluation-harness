import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { agentSchema, type RuntimePort } from "../contracts.js";
import { Database } from "../storage/database.js";
import { AppError } from "../domain/errors.js";
import { createApplication } from "./application.js";
import { targetFixture } from "../../tests/fixtures/runtime-targets.js";

function recordState(reader: DatabaseSync) {
  return JSON.stringify({
    records: reader
      .prepare("SELECT kind,id,value FROM records ORDER BY kind,id")
      .all(),
    events: reader.prepare("SELECT * FROM events ORDER BY sequence").all(),
  });
}

function fixtureRuntime(execute: RuntimePort["execute"]): RuntimePort {
  return {
    ...targetFixture,
    execute,
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
    judge: async () => {
      throw new Error("Unexpected judge call");
    },
    researcher: async () => {
      throw new Error("Unexpected researcher call");
    },
  };
}

it.each(["completed", "cancelled", "failed"] as const)(
  "seals original passes at %s settlement and keeps conditional reads and actions free of writes",
  async (outcome) => {
    const directory = await mkdtemp(join(tmpdir(), "aeh-snapshot-"));
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const execute = vi.fn(
      async (input: Parameters<RuntimePort["execute"]>[0]) => {
        if (input.question.id === "q1") return { answer: 42, text: "42" };
        if (outcome === "failed")
          throw new AppError("fixture_fatal", "Fixture failure.");
        if (outcome === "cancelled") {
          entered();
          await new Promise<void>((_resolve, reject) =>
            input.signal.addEventListener(
              "abort",
              () => reject(input.signal.reason),
              { once: true },
            ),
          );
        }
        return { answer: 41, text: "41" };
      },
    );
    const runtime = fixtureRuntime(execute);
    const app = await createApplication({ dataDirectory: directory, runtime });
    const reader = new DatabaseSync(join(directory, "workspace.sqlite"));
    const records = () => recordState(reader);
    try {
      const bank = await app.execute("banks.create", {
        name: "Snapshot bank",
        questions: [
          { id: "q1", text: "One?", expected: 42 },
          { id: "q2", text: "Two?", expected: 42 },
        ],
      });
      const launched = await app.execute("runs.launch", {
        bankRevisionId: bank.id,
        agent: agentSchema.parse({ harness: "codex", model: "fixture" }),
      });
      const runId = launched.run.id;
      if (outcome === "cancelled") {
        await started;
        await app.execute("runs.control", { runId, action: "cancel" });
      }
      await app.waitForIdle();
      const passId = `original_deterministic_${runId}`;
      expect(
        reader
          .prepare(
            "SELECT value FROM records WHERE kind='assessmentPass' AND id=?",
          )
          .get(passId),
      ).toBeDefined();
      const before = records();
      const view = await app.execute("runs.get", { runId });
      const pass = view.assessmentPasses!.find((item) => item.id === passId)!;
      expect(pass).toHaveProperty("observationRevision", expect.any(String));
      const expectedObservationRevision = pass.observationRevision;
      const detail = await app.execute("runs.assessment", {
        runId,
        passId,
        expectedObservationRevision,
      });
      expect(detail).toHaveProperty(
        "observationRevision",
        expectedObservationRevision,
      );
      expect(detail.coverage).toEqual(pass.coverage);
      const exported = await app.execute("runs.export-assessment", {
        runId,
        passId,
        expectedObservationRevision,
      });
      const { observationRevision: _revision, ...fullPass } = detail;
      expect(exported).toEqual(fullPass);
      expect(exported).not.toHaveProperty("observationRevision");
      const answer = view.attempts.find((attempt) => attempt.hasOutput)!;
      expect(
        await app.execute("runs.attempt", {
          runId,
          attemptId: answer.id,
          expectedEvidenceHash: answer.evidenceHash,
        }),
      ).toHaveProperty("attempt.output.answer", 42);
      await expect(
        app.execute("runs.attempt", {
          runId,
          attemptId: answer.id,
          expectedEvidenceHash: "wrong-evidence",
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      for (const operation of [
        "runs.assessment",
        "runs.export-assessment",
        "runs.review-assessment",
        "runs.retry-assessment",
      ] as const) {
        await expect(
          app.execute(operation, {
            runId,
            expectedObservationRevision: "stale-revision",
            ...(operation === "runs.review-assessment"
              ? { parentPassId: passId, name: "Stale review", overrides: [] }
              : { passId }),
          }),
        ).rejects.toMatchObject({ code: "conflict" });
      }
      expect(records()).toBe(before);
      expect(view.run.status).toBe(outcome);
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      reader.close();
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("changes revisions for new sealed answers at the same interrupted status and rejects the old snapshot before writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeh-live-snapshot-"));
  let admitted!: () => void;
  let started = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  const calls = new Map<string, number>();
  const execute = vi.fn(
    async (input: Parameters<RuntimePort["execute"]>[0]) => {
      const count = (calls.get(input.question.id) ?? 0) + 1;
      calls.set(input.question.id, count);
      if (input.question.id !== "q1" && count === 1) {
        admitted();
        await new Promise<void>((_resolve, reject) =>
          input.signal.addEventListener(
            "abort",
            () => reject(input.signal.reason),
            { once: true },
          ),
        );
      }
      const answer = input.question.id === "q2" ? 41 : 42;
      return { answer, text: String(answer) };
    },
  );
  const runtime = fixtureRuntime(execute);
  let app = await createApplication({ dataDirectory: directory, runtime });
  const reader = new DatabaseSync(join(directory, "workspace.sqlite"));
  const records = () => recordState(reader);
  try {
    const bank = await app.execute<"banks.create">("banks.create", {
      name: "Live snapshot",
      questions: ["q1", "q2", "q3"].map((id) => ({
        id,
        text: `${id}?`,
        expected: 42,
      })),
    });
    const launched = await app.execute("runs.launch", {
      bankRevisionId: bank.id,
      agent: agentSchema.parse({ harness: "codex", model: "fixture" }),
      limits: { concurrency: 1 },
    });
    const runId = launched.run.id;
    await started;
    await app.execute("runs.control", { runId, action: "halt" });
    await app.waitForIdle();
    const old = (await app.execute("runs.get", { runId }))
      .assessmentPasses![0]!;
    await app.execute("runs.assessment", {
      runId,
      passId: old.id,
      expectedObservationRevision: old.observationRevision,
    });
    started = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    await app.execute("runs.control", { runId, action: "resume" });
    await started;
    await app.execute("runs.control", { runId, action: "halt" });
    await app.waitForIdle();
    const changed = (await app.execute("runs.get", { runId }))
      .assessmentPasses![0]!;
    expect(old.status).toBe("interrupted");
    expect(changed.status).toBe("interrupted");
    expect(changed.observationRevision).not.toBe(old.observationRevision);
    expect(changed.coverage).toMatchObject({ correct: 1, judged: 2 });
    const before = records();
    for (const operation of [
      "runs.assessment",
      "runs.export-assessment",
      "runs.review-assessment",
      "runs.retry-assessment",
    ] as const) {
      await expect(
        app.execute(operation, {
          runId,
          expectedObservationRevision: old.observationRevision,
          ...(operation === "runs.review-assessment"
            ? { parentPassId: old.id, name: "Stale", overrides: [] }
            : { passId: old.id }),
        }),
      ).rejects.toMatchObject({ code: "conflict" });
    }
    expect(records()).toBe(before);
    const detail = await app.execute("runs.assessment", {
      runId,
      passId: changed.id,
      expectedObservationRevision: changed.observationRevision,
    });
    expect(detail.observationRevision).toBe(changed.observationRevision);
    expect(detail.judgments).toMatchObject(changed.judgments);
    const originalAnswer = detail.judgments.find(
      (judgment) => judgment.status === "correct",
    )!;
    expect(old.judgments[0]).toMatchObject(originalAnswer);
    // Simulate a legacy terminal run whose originals were not yet materialized.
    await app.close();
    const db = new Database(join(directory, "workspace.sqlite"));
    db.update("run", {
      ...db.require("run", runId),
      status: "cancelled",
      intent: "cancel",
    });
    db.close();
    app = await createApplication({ dataDirectory: directory, runtime });
    expect(
      reader
        .prepare(
          "SELECT value FROM records WHERE kind='assessmentPass' AND id=?",
        )
        .get(changed.id),
    ).toBeDefined();
    const recovered = (await app.execute("runs.get", { runId }))
      .assessmentPasses![0]!;
    const recoveredRecords = records();
    await app.close();
    app = await createApplication({ dataDirectory: directory, runtime });
    const reopened = (await app.execute("runs.get", { runId }))
      .assessmentPasses![0]!;
    expect(reopened).toEqual(recovered);
    expect(records()).toBe(recoveredRecords);
    expect(
      reader
        .prepare(
          "SELECT COUNT(*) AS count FROM records WHERE kind='assessmentPass' AND json_type(value,'$.observationRevision') IS NOT NULL",
        )
        .get()!.count,
    ).toBe(0);
    expect(execute).toHaveBeenCalledTimes(4);
  } finally {
    reader.close();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["published rescore", "retry parent"] as const)(
  "keeps the %s fixed when the original run resumes",
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "aeh-frozen-basis-"));
    let admitted!: () => void;
    const started = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    let q2Calls = 0;
    const runtime = fixtureRuntime(async (input) => {
      if (input.question.id === "q2" && ++q2Calls === 1) {
        admitted();
        await new Promise<void>((_resolve, reject) =>
          input.signal.addEventListener(
            "abort",
            () => reject(input.signal.reason),
            { once: true },
          ),
        );
      }
      return { answer: 42, text: "42" };
    });
    let judgeFails = true;
    runtime.judge = async () => {
      if (judgeFails) throw new Error("Local judge failure");
      return { verdict: true };
    };
    const app = await createApplication({ dataDirectory: directory, runtime });
    try {
      const bank = await app.execute("banks.create", {
        name: "Frozen basis",
        questions: [
          { id: "q1", text: "One?", expected: 42 },
          { id: "q2", text: "Two?", expected: 42 },
        ],
      });
      const agent = agentSchema.parse({ harness: "codex", model: "fixture" });
      const launched = await app.execute("runs.launch", {
        bankRevisionId: bank.id,
        agent,
        limits: { concurrency: 1 },
        ...(kind === "retry parent"
          ? {
              judge: {
                enabled: true,
                agent,
                instructions: "Judge saved answers.",
              },
            }
          : {}),
      });
      const runId = launched.run.id;
      await started;
      await app.execute("runs.control", { runId, action: "halt" });
      await app.waitForIdle();
      let passId: string;
      if (kind === "published rescore") {
        const scores = await app.execute("runs.rescore", {
          runId,
          evaluatorRevisionId: launched.run.manifest.evaluator.id,
          publish: true,
        });
        passId = `scores_${scores.id}`;
      } else {
        const original = await app.execute("runs.assessment", {
          runId,
          passId: `original_llm_${runId}`,
        });
        judgeFails = false;
        const retry = await app.execute("runs.retry-assessment", {
          runId,
          passId: original.id,
          expectedObservationRevision: original.observationRevision,
        });
        passId = retry.parentPassId!;
        expect(passId).not.toBe(original.id);
      }
      const before = await app.execute("runs.assessment", { runId, passId });
      const summaryBefore = (await app.execute("runs.list", {})).runs
        .find((run) => run.id === runId)!
        .assessmentPasses!.find((pass) => pass.id === passId)!;
      await app.execute("runs.control", { runId, action: "resume" });
      await app.waitForIdle();
      const after = await app.execute("runs.assessment", { runId, passId });
      const summaryAfter = (await app.execute("runs.list", {})).runs
        .find((run) => run.id === runId)!
        .assessmentPasses!.find((pass) => pass.id === passId)!;
      expect(after).toEqual(before);
      expect(summaryAfter).toEqual(summaryBefore);
      expect(
        after.judgments.find(
          (judgment) => judgment.resultId === launched.results[1]!.id,
        ),
      ).not.toHaveProperty("attemptId");
      expect(q2Calls).toBe(2);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
