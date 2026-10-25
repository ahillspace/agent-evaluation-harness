import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { createApplication } from "./application.js";
import { agentSchema, commandSchemas, type RuntimePort } from "../contracts.js";
import { targetFixture } from "../../tests/fixtures/runtime-targets.js";
import { Database } from "../storage/database.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "aeh-review-migration-"));
  const agent = agentSchema.parse({ harness: "codex", model: "fixture" });
  const execute = vi
    .fn<RuntimePort["execute"]>()
    .mockResolvedValue({ answer: 42, text: "42" });
  const judge = vi.fn<RuntimePort["judge"]>();
  const runtime: RuntimePort = {
    ...targetFixture,
    execute,
    judge,
    researcher: async () => {
      throw Error("Unused");
    },
    resolveAgent: async (value) => value,
    discover: async () => ({
      harnesses: [],
      connectionProviders: [],
      maxConcurrency: 1,
    }),
    recover: async () => ({ recovered: [], errors: [] }),
    close: async () => {},
    listConnections: async () => [],
    deleteConnection: async () => {},
    saveConnection: async () => {
      throw Error("Unused");
    },
    testConnection: async () => ({ ok: true, message: "ok" }),
  };
  const app = await createApplication({ dataDirectory: directory, runtime });
  return { app, runtime, directory, agent, execute, judge };
}

it.each(["normal", "selection-gap"])(
  "recovers legacy reviews with %s using the exact score basis",
  async (mode) => {
    const {
      runtime,
      directory,
      agent,
      execute,
      judge,
      app: started,
    } = await fixture();
    let app = started;
    try {
      const bank = await app.execute("banks.create", {
        name: "Reviewed",
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
      const runId = launched.run.id;
      const original = await app.execute("runs.get", { runId });
      const scores = await app.execute("runs.rescore", {
        runId,
        evaluatorRevisionId: launched.run.manifest.evaluator.id,
        publish: false,
      });
      const [first, second] = original.results;
      const reviews = [
        {
          id: "legacy-1",
          runId,
          resultId: first!.id,
          verdict: false,
          note: "First correction",
          reviewer: "Reviewer One",
          createdAt: "2026-01-01T01:00:00.000Z",
        },
        {
          id: "legacy-2",
          runId,
          resultId: second!.id,
          scoreSetId: `original_${runId}`,
          verdict: false,
          note: "Second correction",
          reviewer: "Reviewer Two",
          createdAt: "2026-01-01T02:00:00.000Z",
        },
        {
          id: "legacy-3",
          runId,
          resultId: first!.id,
          scoreSetId: scores.id,
          verdict: true,
          note: "Saved score review",
          reviewer: "Reviewer Three",
          createdAt: "2026-01-01T03:00:00.000Z",
        },
      ];
      await app.close();
      const db = new Database(join(directory, "workspace.sqlite"));
      for (const review of reviews) db.insert("review", review);
      db.close();
      app = await createApplication({ dataDirectory: directory, runtime });
      const restored = await app.execute("runs.get", { runId });
      const humans = restored.assessmentPasses!.filter(
        (pass) => pass.source === "human",
      );
      expect(humans).toHaveLength(3);
      const recovered = await Promise.all(
        humans.map((pass) =>
          app.execute("runs.assessment", { runId, passId: pass.id }),
        ),
      );
      const chained = recovered.find(
        (pass) => pass.createdAt === reviews[1]!.createdAt,
      )!;
      expect(chained.coverage).toMatchObject({ incorrect: 2, reviewed: 2 });
      expect(chained.judgments[0]).toMatchObject({
        attemptId: first!.completedAttemptId,
        evidenceHash: expect.any(String),
        review: {
          reviewer: reviews[0]!.reviewer,
          note: reviews[0]!.note,
          createdAt: reviews[0]!.createdAt,
        },
      });
      const rescored = recovered.find(
        (pass) => pass.createdAt === reviews[2]!.createdAt,
      )!;
      expect(rescored.parentPassId).toBe(`scores_${scores.id}`);
      const baseline = await app.execute("runs.assessment", {
        runId,
        passId: `original_deterministic_${runId}`,
      });
      expect(baseline.coverage.correct).toBe(2);
      if (mode === "selection-gap") {
        await app.close();
        const interrupted = new Database(join(directory, "workspace.sqlite"));
        interrupted.update("run", {
          ...interrupted.require("run", runId),
          selectedAssessmentPassId: undefined,
        });
        interrupted.close();
        app = await createApplication({ dataDirectory: directory, runtime });
        expect(
          (await app.execute("runs.get", { runId })).selectedAssessmentPassId,
        ).toBe(rescored.id);
      }
      await app.execute("runs.select-assessment", {
        runId,
        passId: baseline.id,
      });
      await app.close();
      app = await createApplication({ dataDirectory: directory, runtime });
      const restarted = await app.execute("runs.get", { runId });
      expect(
        restarted
          .assessmentPasses!.filter((pass) => pass.source === "human")
          .map((pass) => pass.id),
      ).toEqual(humans.map((pass) => pass.id));
      expect(restarted.selectedAssessmentPassId).toBe(baseline.id);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(judge).not.toHaveBeenCalled();
      expect(commandSchemas).not.toHaveProperty("runs.review");
      await expect(app.execute("runs.review", { runId })).rejects.toThrow();
      await app.close();
      const saved = new Database(join(directory, "workspace.sqlite"));
      expect(saved.list("review", { runId })).toEqual(reviews);
      saved.close();
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("preserves an ambiguous applied-answer legacy review without blocking startup or guessing answer provenance", async () => {
  const { runtime, directory, agent, execute, app: started } = await fixture();
  let app = started;
  try {
    execute.mockRejectedValueOnce(Error("Original target failed"));
    const bank = await app.execute("banks.create", {
      name: "Applied legacy",
      questions: [{ id: "q", text: "Count", expected: 42 }],
    });
    const launched = await app.execute("runs.launch", {
      bankRevisionId: bank.id,
      agent,
    });
    await app.waitForIdle();
    const runId = launched.run.id;
    const original = await app.execute("runs.get", { runId });
    const retry = await app.execute("runs.retry-failed", {
      runId,
      acknowledgeDuplicateWork: true,
      idempotencyKey: "retry",
    });
    await app.waitForIdle();
    await app.execute("runs.apply-retry", {
      runId,
      retryRunId: retry.run.id,
      idempotencyKey: "apply",
    });
    const review = {
      id: "ambiguous-review",
      runId,
      resultId: original.results[0]!.id,
      verdict: true,
      note: "Historical applied answer accepted",
      reviewer: "Past Reviewer",
      createdAt: "2026-01-01T01:00:00.000Z",
    };
    await app.close();
    const db = new Database(join(directory, "workspace.sqlite"));
    db.insert("review", review);
    db.close();
    app = await createApplication({ dataDirectory: directory, runtime });
    const recovered = await app.execute("runs.get", { runId });
    const human = recovered.assessmentPasses!.find(
      (pass) => pass.source === "human",
    )!;
    const pass = await app.execute("runs.assessment", {
      runId,
      passId: human.id,
    });
    expect(pass.createdAt).toBe(review.createdAt);
    expect(pass.judgments[0]).toMatchObject({
      status: "unjudged",
      explanation: expect.stringMatching(/provenance|answer source/i),
      review: {
        note: review.note,
        reviewer: review.reviewer,
        createdAt: review.createdAt,
      },
      details: { legacyReview: review, provenance: "unresolved" },
    });
    expect(pass.judgments[0]?.attemptId).toBeUndefined();
    expect(pass.judgments[0]?.evidenceHash).toBeUndefined();
    await expect(
      app.execute("runs.review-assessment", {
        runId,
        parentPassId: pass.id,
        name: "Must identify an answer",
        overrides: [{ resultId: review.resultId, verdict: true }],
      }),
    ).rejects.toThrow(/sealed answer/);
    await app.close();
    app = await createApplication({ dataDirectory: directory, runtime });
    expect(
      (await app.execute("runs.assessment", { runId, passId: pass.id }))
        .judgments,
    ).toEqual(pass.judgments);
    expect(execute).toHaveBeenCalledTimes(2);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
