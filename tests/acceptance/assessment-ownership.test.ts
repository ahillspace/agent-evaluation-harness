import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createApplication } from "../../src/application/application.js";
import {
  agentSchema,
  commandSchemas,
  type RuntimePort,
} from "../../src/contracts.js";
import { startServer } from "../../src/server.js";
import { Database } from "../../src/storage/database.js";
import { targetFixture } from "../fixtures/runtime-targets.js";

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("saves automatic and named scores through assessment passes across HTTP without creating ScoreSets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeh-score-owner-"));
  cleanups.push(() =>
    rm(directory, { recursive: true, force: true, maxRetries: 3 }),
  );
  const execute = vi.fn(async () => ({ answer: 42, text: "42" }));
  const runtime: RuntimePort = {
    ...targetFixture,
    recover: async () => ({ recovered: [], errors: [] }),
    close: async () => {},
    resolveAgent: async (agent) => agent,
    execute,
    judge: async () => ({
      verdict: true,
      explanation: "Fixture judge accepts the answer.",
    }),
    researcher: async () => {
      throw new Error("Unexpected researcher invocation");
    },
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
  const server = await startServer({ application, port: 0, host: "127.0.0.1" });
  cleanups.push(() => server.close());
  const reader = new DatabaseSync(join(directory, "workspace.sqlite"), {
    readOnly: true,
  });
  cleanups.push(() => reader.close());
  const records = () =>
    JSON.stringify({
      records: reader
        .prepare("SELECT kind,id,value FROM records ORDER BY kind,id")
        .all(),
      events: reader.prepare("SELECT * FROM events ORDER BY sequence").all(),
    });
  async function post(operation: string, input: unknown) {
    const response = await fetch(`${server.url}/api/commands/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(response.ok).toBe(true);
    return response.json();
  }
  const bank = await post("banks.create", {
    name: "Aggregate ownership",
    questions: [{ id: "q1", text: "Count?", expected: 42 }],
  });
  const launched = await post("runs.launch", {
    bankRevisionId: bank.id,
    agent: agentSchema.parse({ harness: "codex", model: "fixture" }),
  });
  await application.waitForIdle();
  const original = await post("runs.get", { runId: launched.run.id });
  expect(original.assessmentPasses[0].coverage).toMatchObject({
    correct: 1,
    judged: 1,
  });
  expect(
    reader
      .prepare("SELECT COUNT(*) AS count FROM records WHERE kind='scoreSet'")
      .get()!.count,
  ).toBe(0);
  const second = await post("runs.launch", {
    bankRevisionId: bank.id,
    agent: agentSchema.parse({ harness: "codex", model: "fixture" }),
  });
  await application.waitForIdle();
  const corrected = await post("banks.revise", {
    bankId: bank.bankId,
    baseRevisionId: bank.id,
    baseEvaluatorRevisionId: launched.run.manifest.evaluator.id,
    name: bank.name,
    questions: [{ id: "q1", text: "Count?", expected: 43 }],
  });
  const named = await post("runs.assess", {
    runId: launched.run.id,
    source: "deterministic",
    name: "Saved answer rules",
    evaluatorRevisionId: launched.run.manifest.evaluator.id,
    bankRevisionId: corrected.id,
  });
  await post("runs.review-assessment", {
    runId: launched.run.id,
    parentPassId: named.id,
    name: "Human accepts the answer",
    overrides: [{ resultId: launched.results[0].id, verdict: true }],
  });
  await post("runs.assess", {
    runId: launched.run.id,
    source: "llm",
    name: "Later LLM accepts the answer",
    evaluatorRevisionId: launched.run.manifest.evaluator.id,
    judge: {
      enabled: true,
      agent: agentSchema.parse({ harness: "codex", model: "fixture" }),
    },
  });
  const beforeComparison = records();
  const compared = await post("runs.compare", {
    runIds: [launched.run.id, second.run.id],
    evaluatorRevisionId: launched.run.manifest.evaluator.id,
  });
  expect(compared.rows[0]).toMatchObject({
    assessmentPassId: named.id,
    accuracy: 0,
    graded: 1,
  });
  expect(records()).toBe(beforeComparison);
  const latestReview = await post("runs.review-assessment", {
    runId: launched.run.id,
    parentPassId: original.assessmentPasses[0].id,
    name: "Selected human rejects the answer",
    overrides: [{ resultId: launched.results[0].id, verdict: false }],
  });
  await post("runs.select-assessment", {
    runId: launched.run.id,
    passId: latestReview.id,
  });
  const draft = await post("evaluators.draft", {
    bankId: bank.bankId,
    name: "Preview",
    settings: {},
  });
  const beforePreview = records();
  const preview = await post("evaluators.preview", {
    draftId: draft.id,
    runIds: [launched.run.id],
  });
  expect(preview.runs[0].rows[0]).toMatchObject({
    before: { status: "correct" },
    after: { status: "correct" },
  });
  expect(records()).toBe(beforePreview);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(
    reader
      .prepare("SELECT COUNT(*) AS count FROM records WHERE kind='scoreSet'")
      .get()!.count,
  ).toBe(0);
  expect(commandSchemas).not.toHaveProperty("runs.rescore");
  expect(commandSchemas).not.toHaveProperty("runs.publish-score");

  // Seed historical records that the retired writers previously produced.
  const historical = new Database(join(directory, "workspace.sqlite"));
  const savedAt = Date.now();
  historical.insert(
    "scoreSet",
    {
      id: "legacy-published",
      runId: launched.run.id,
      evaluator: launched.run.manifest.evaluator,
      createdAt: new Date(savedAt + 1000).toISOString(),
      kind: "rescore",
      published: true,
      assessments: historical.list("assessment", { runId: launched.run.id }),
    },
    true,
  );
  historical.insert("scoreSet", {
    id: "legacy-unpublished",
    runId: launched.run.id,
    evaluator: launched.run.manifest.evaluator,
    createdAt: new Date(savedAt + 2000).toISOString(),
    kind: "rescore",
    published: false,
    assessments: [],
  });
  historical.insert("scoreSet", {
    id: "unselected-run-legacy-draft",
    runId: second.run.id,
    evaluator: launched.run.manifest.evaluator,
    createdAt: new Date(savedAt + 2000).toISOString(),
    kind: "rescore",
    published: false,
    assessments: [],
  });
  historical.insert("assessmentPass", {
    ...named,
    id: "unfinished-deterministic",
    name: "Unfinished newer deterministic assessment",
    createdAt: new Date(savedAt + 3000).toISOString(),
    status: "running",
    finishedAt: undefined,
  });
  historical.close();
  const beforeLegacyReads = records();
  const legacyComparison = await post("runs.compare", {
    runIds: [launched.run.id, second.run.id],
    evaluatorRevisionId: launched.run.manifest.evaluator.id,
  });
  expect(legacyComparison.rows[0]).toMatchObject({
    assessmentPassId: "scores_legacy-published",
    accuracy: 1,
    graded: 1,
  });
  const legacyPass = await post("runs.assessment", {
    runId: launched.run.id,
    passId: "scores_legacy-published",
  });
  expect(legacyPass.judgments[0]).toMatchObject({
    attemptId: original.results[0].completedAttemptId,
    evidenceHash: original.assessmentPasses[0].judgments[0].evidenceHash,
  });
  const unpublished = await post("runs.assessment", {
    runId: launched.run.id,
    passId: "scores_legacy-unpublished",
  });
  expect(unpublished.name).toContain("unpublished historical score");
  expect(unpublished.judgments[0]).not.toHaveProperty("attemptId");
  const exportedDraft = await post("runs.export-assessment", {
    runId: launched.run.id,
    passId: unpublished.id,
  });
  expect(exportedDraft.judgments).toEqual(unpublished.judgments);
  const defaultView = await post("runs.get", { runId: second.run.id });
  expect(defaultView.selectedAssessmentPassId).toBe(
    `original_deterministic_${second.run.id}`,
  );
  expect(defaultView.assessmentPasses[0].id).toBe(
    defaultView.selectedAssessmentPassId,
  );
  const library = await post("runs.list", {});
  expect(
    library.runs.find((run: { id: string }) => run.id === second.run.id)
      .selectedAssessmentPassId,
  ).toBe(defaultView.selectedAssessmentPassId);
  expect(records()).toBe(beforeLegacyReads);
  expect(execute).toHaveBeenCalledTimes(2);
});
