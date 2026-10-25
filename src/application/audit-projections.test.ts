import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  agentSchema,
  evaluatorSettingsSchema,
  type RuntimePort,
  type Json,
} from "../contracts.js";
import { targetFixture } from "../../tests/fixtures/runtime-targets.js";
import { createApplication } from "./application.js";
import { startServer } from "../server.js";
import { grade } from "../evaluation/scoring.js";
import { Database } from "../storage/database.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const agent = agentSchema.parse({ harness: "codex", model: "fixture" });
async function setup(execute: RuntimePort["execute"]) {
  const directory = await mkdtemp(join(tmpdir(), "aeh-audit-projections-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const runtime: RuntimePort = {
    ...targetFixture,
    execute,
    resolveAgent: async (value) => value,
    discover: async () => ({
      harnesses: [],
      connectionProviders: [],
      maxConcurrency: 1,
    }),
    recover: async () => ({ recovered: [], errors: [] }),
    close: async () => {},
    listConnections: async () => [],
    saveConnection: async () => {
      throw new Error("Unused");
    },
    deleteConnection: async () => {},
    testConnection: async () => ({ ok: true, message: "Fixture" }),
    judge: async () => {
      throw new Error("Unexpected judge");
    },
    researcher: async () => ({
      conversationId: "fixture",
      message: "Complete",
      control: "stop",
    }),
  };
  const app = await createApplication({ dataDirectory: directory, runtime });
  cleanups.push(() => app.close());
  const server = await startServer({
    application: app,
    host: "127.0.0.1",
    port: 0,
  });
  cleanups.push(() => server.close());
  async function post(operation: string, input: unknown) {
    return fetch(`${server.url}/api/commands/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }
  return { app, post, directory };
}
type Evidence = {
  results: Array<{
    resultId: string;
    expected?: Json;
    attempts: Array<{
      id: string;
      events: Array<{ type: string; message: string; runId: string }>;
    }>;
  }>;
};

it("research evidence drains each physical attempt and includes adopted retry evidence through HTTP", async () => {
  let fail = true;
  const { app, post, directory } = await setup(async (input) => {
    input.onEvent({
      type: "tool.result",
      message: `trace-${input.question.id}-0`,
    });
    const history = new Database(join(directory, "workspace.sqlite"));
    try {
      // Seed the middle of the recorded history without thousands of disk commits.
      history.transaction(() => {
        for (let index = 1; index < 5004; index++)
          history.append({
            runId: input.runId,
            attemptId: input.attemptId,
            type: "tool.result",
            message: `trace-${input.question.id}-${index}`,
          });
      });
    } finally {
      history.close();
    }
    input.onEvent({
      type: "tool.result",
      message: `trace-${input.question.id}-5004`,
    });
    input.onEvent({ type: "judge.fixture", message: "private-judge-marker" });
    if (input.question.id === "retry" && fail)
      throw new Error("Fixture failure");
    return { answer: 42, text: "42" };
  });
  const bank = await app.execute("banks.create", {
    name: "Evidence",
    questions: [
      { id: "ok", text: "Answer", expected: 42 },
      { id: "retry", text: "Answer again", expected: 42 },
    ],
  });
  const session = await app.execute("research.launch", {
    baseline: { bankRevisionId: bank.id, agent },
    researcher: agent,
    objective: "Accuracy",
    maxCandidates: 1,
  });
  await app.waitForIdle();
  const runId = session.session.baselineRunId;
  fail = false;
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
  const view = await app.execute("runs.get", { runId });
  const recovered = view.results.find(
    (result) => result.questionId === "retry",
  )!;
  for (const includeGold of [false, true]) {
    const response = await post("research.evidence", {
      sessionId: session.session.id,
      runId,
      includeGold,
    });
    expect(response.ok).toBe(true);
    const evidence = (await response.json()) as Evidence;
    for (const result of evidence.results) {
      expect(result.expected).toBe(includeGold ? 42 : undefined);
      for (const attempt of result.attempts) {
        expect(
          attempt.events.filter((event) => event.type === "tool.result"),
        ).toHaveLength(5005);
        expect(
          attempt.events.some((event) => event.message.endsWith("-0")),
        ).toBe(true);
        expect(
          attempt.events.some((event) => event.message.endsWith("-5004")),
        ).toBe(true);
        expect(
          attempt.events.some((event) => event.type === "judge.fixture"),
        ).toBe(includeGold);
      }
    }
    expect(
      evidence.results
        .find((result) => result.resultId === recovered.id)!
        .attempts.map((attempt) => attempt.id),
    ).toContain(recovered.answerSource!.attemptId);
  }
  const denied = await post("research.evidence", {
    sessionId: session.session.id,
    runId: retry.run.id,
  });
  expect(denied.ok).toBe(false);
  const history = await app.execute("research.get", {
    sessionId: session.session.id,
  });
  expect(
    history.events.some((event) => event.type === "research.gold.retrieved"),
  ).toBe(true);
}, 45_000);

it("rejects an oversized evidence response explicitly and supports selecting one result", async () => {
  const { app, post } = await setup(async (input) => {
    input.onEvent({
      type: "tool.result",
      message: "Large saved trace",
      data: { text: "x".repeat(9 * 1024 * 1024) },
    });
    return { answer: 42, text: "42" };
  });
  const bank = await app.execute("banks.create", {
    name: "Large evidence",
    questions: [
      { id: "a", text: "Answer", expected: 42 },
      { id: "b", text: "Answer again", expected: 42 },
    ],
  });
  const session = await app.execute("research.launch", {
    baseline: { bankRevisionId: bank.id, agent },
    researcher: agent,
    objective: "Accuracy",
    maxCandidates: 1,
  });
  await app.waitForIdle();
  const request = {
    sessionId: session.session.id,
    runId: session.session.baselineRunId,
  };
  const response = await post("research.evidence", request);
  expect(response.ok).toBe(false);
  expect(await response.json()).toMatchObject({
    error: {
      code: "evidence_limit",
      message: expect.stringMatching(/16 MiB.*resultId/),
    },
  });
  const view = await app.execute("runs.get", { runId: request.runId });
  const selected = await post("research.evidence", {
    ...request,
    resultId: view.results[0]!.id,
  });
  expect(selected.ok).toBe(true);
  const evidence = (await selected.json()) as Evidence;
  expect(evidence.results).toHaveLength(1);
  expect(
    evidence.results[0]!.attempts[0]!.events.some(
      (event) => event.message === "Large saved trace",
    ),
  ).toBe(true);
}, 30_000);

it("comparison reports partial logical recovery while retaining historical pass scores through HTTP", async () => {
  let fail = true;
  const { app, post } = await setup(async () => {
    if (fail)
      throw Object.assign(new Error("Fixture failure"), {
        code: "target_failure",
      });
    return { answer: 42, text: "42" };
  });
  const bank = await app.execute("banks.create", {
    name: "Recovery",
    questions: [{ id: "q", text: "Answer", expected: 42 }],
  });
  const original = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
    repetitions: 2,
  });
  await app.waitForIdle();
  const before = await app.execute("runs.get", { runId: original.run.id });
  expect(before.progress).toEqual({ completed: 0, failed: 2, total: 2 });
  const historicalId = before.assessmentPasses![0]!.id;
  const historical = await app.execute("runs.assessment", {
    runId: original.run.id,
    passId: historicalId,
  });
  fail = false;
  const retry = await app.execute("runs.retry-failed", {
    runId: original.run.id,
    acknowledgeDuplicateWork: true,
    idempotencyKey: "retry",
  });
  await app.waitForIdle();
  await app.execute("runs.apply-retry", {
    runId: original.run.id,
    retryRunId: retry.run.id,
    resultIds: [before.results[0]!.id],
    idempotencyKey: "apply",
  });
  const response = await post("runs.compare", {
    runIds: [original.run.id, retry.run.id],
  });
  expect(response.ok).toBe(true);
  expect((await response.json()).rows[0]).toMatchObject({
    completed: 1,
    failed: 1,
    total: 2,
    accuracy: 1,
  });
  const physical = await app.execute("runs.attempt", {
    runId: original.run.id,
    attemptId: before.results[0]!.attemptIds[0]!,
  });
  expect(physical.attempt.status).toBe("failed");
  await app.execute("runs.select-assessment", {
    runId: original.run.id,
    passId: historicalId,
  });
  const comparison = await app.execute("runs.compare", {
    runIds: [original.run.id, retry.run.id],
  });
  expect(comparison.rows[0]).toMatchObject({
    completed: 1,
    failed: 1,
    accuracy: null,
    graded: 0,
    scoreSetId: historicalId,
  });
  expect(
    await app.execute("runs.assessment", {
      runId: original.run.id,
      passId: historicalId,
    }),
  ).toEqual(historical);
  const rescored = await app.execute("runs.rescore", {
    runId: original.run.id,
    evaluatorRevisionId: before.run.manifest.evaluator.id,
    publish: true,
  });
  const explicit = await app.execute("runs.compare", {
    runIds: [original.run.id, retry.run.id],
    evaluatorRevisionId: rescored.evaluator.id,
  });
  expect(explicit.rows[0]).toMatchObject({
    completed: 1,
    failed: 1,
    accuracy: 1,
  });
});

const question = {
  id: "table",
  text: "Sort counts",
  expected: {
    type: "table",
    columns: [{ name: "n", type: "integer" }],
    rows: [{ n: 2 }, { n: 1 }],
  },
};
it.each([
  { sortOrder: [{ column: "n", direction: "asc" }] },
  { duplicateRows: "distinct" },
  { columnAliases: { n: ["count"] } },
  { tableOrder: "unordered" },
  { orderBy: ["n"] },
  { allowColumnPermutation: true },
  { collation: { locale: "en-US" } },
])(
  "rejects authored table policies without their grader: %j",
  async (policy) => {
    const { app, post } = await setup(async () => ({ answer: 42, text: "42" }));
    const settings = { mode: "json", ...policy };
    const response = await post("banks.publish", {
      name: "Invalid policy",
      evaluatorName: "Fixture",
      questions: [question],
      evaluatorSettings: settings,
    });
    expect(response.ok).toBe(false);
    expect((await response.json()).error.message).toMatch(
      /Auto|table|policy|ordering|collation/i,
    );
    expect((await app.execute("workspace.get", {})).banks).toHaveLength(0);
    const check = await post("banks.check-answer", {
      question,
      settings,
      answer: [{ n: 1 }, { n: 2 }],
    });
    expect(check.ok).toBe(false);
    const calibration = await post("banks.calibrate-draft", {
      questions: [question],
      settings,
    });
    expect(calibration.ok).toBe(false);
  },
);

it("validates effective overrides and grades ascending and descending public rows", async () => {
  const { post } = await setup(async () => ({ answer: 42, text: "42" }));
  for (const direction of ["asc", "desc"]) {
    const settings = {
      mode: "json",
      questionOverrides: {
        table: { mode: "auto", sortOrder: [{ column: "n", direction }] },
      },
    };
    const response = await post("banks.publish", {
      name: direction,
      evaluatorName: "Fixture",
      questions: [question],
      evaluatorSettings: settings,
    });
    expect(response.ok).toBe(true);
    const check = await post("banks.check-answer", {
      question,
      settings,
      answer: direction === "asc" ? [{ n: 1 }, { n: 2 }] : [{ n: 2 }, { n: 1 }],
    });
    expect(await check.json()).toMatchObject({ status: "correct" });
  }
  const invalid = await post("banks.publish", {
    name: "Override",
    evaluatorName: "Fixture",
    questions: [question],
    evaluatorSettings: {
      sortOrder: [{ column: "n", direction: "asc" }],
      questionOverrides: { table: { mode: "json" } },
    },
  });
  expect(invalid.ok).toBe(false);
});

it.each([
  { collation: { locale: "en-US" } },
  {
    collation: { locale: "en-US" },
    sortOrder: [{ column: "n", direction: "asc" }],
  },
  { orderBy: ["n"] },
  { tableOrder: "unordered", orderBy: ["n"] },
  { orderBy: ["n"], sortOrder: [{ column: "n", direction: "asc" }] },
])(
  "rejects authored settings with no active ordering consumer: %j",
  async (settings) => {
    const { post } = await setup(async () => ({ answer: 42, text: "42" }));
    const response = await post("banks.calibrate-draft", {
      questions: [question],
      settings,
    });
    expect(response.ok).toBe(false);
    expect((await response.json()).error.message).toMatch(
      /collation|ordering/i,
    );
  },
);

it("preserves historical JSON replay semantics while authoring rejects inactive typed policies", async () => {
  const settings = evaluatorSettingsSchema.parse({
    mode: "json",
    arrayOrderMatters: false,
    sortOrder: [{ column: "n", direction: "asc" }],
  });
  const verdict = await grade(
    question.expected,
    { ...question.expected, rows: [{ n: 1 }, { n: 2 }] },
    settings,
  );
  expect(verdict.status).toBe("correct");
});

it("consumes aliases, distinct grain, ordered keys, and string collation in accepted Auto policies", async () => {
  const { post } = await setup(async () => ({ answer: 42, text: "42" }));
  const cases = [
    {
      question,
      settings: { duplicateRows: "distinct", columnAliases: { n: ["count"] } },
      answer: [{ count: 1 }, { count: 2 }, { count: 2 }],
    },
    {
      question,
      settings: { tableOrder: "ordered", orderBy: ["n"] },
      answer: [{ n: 2 }, { n: 1 }],
    },
    {
      question: {
        ...question,
        expected: {
          type: "table",
          columns: [{ name: "label", type: "string" }],
          rows: [{ label: "b10" }, { label: "b2" }],
        },
      },
      settings: {
        sortOrder: [{ column: "label", direction: "asc" }],
        collation: { locale: "en-US", numeric: true },
      },
      answer: [{ label: "b2" }, { label: "b10" }],
    },
  ];
  for (const input of cases) {
    const response = await post("banks.check-answer", input);
    expect(response.ok).toBe(true);
    expect(await response.json()).toMatchObject({ status: "correct" });
  }
});
