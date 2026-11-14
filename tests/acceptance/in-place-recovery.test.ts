import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createApplication } from "../../src/application/application.js";
import type {
  CommandInput,
  CommandName,
  CommandResultMap,
  RuntimePort,
} from "../../src/contracts.js";
import { httpTargetSchema } from "../../src/contracts/http-target.js";
import { createRuntime } from "../../src/runtime/index.js";
import { startServer } from "../../src/server.js";
import { Database } from "../../src/storage/database.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanups.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  vi.useRealTimers();
  if (errors.length)
    throw new AggregateError(errors, "Fixture cleanup failed.");
});

interface TargetRequest {
  questionId: string;
  runId: string;
  attemptId: string;
}

async function fixture(
  reply: (
    request: TargetRequest,
    response: ServerResponse,
    questionAttempt: number,
  ) => void,
) {
  const directory = await mkdtemp(join(tmpdir(), "aeh-in-place-recovery-"));
  cleanups.push(() =>
    rm(directory, { recursive: true, force: true, maxRetries: 3 }),
  );
  const requests: TargetRequest[] = [];
  const waiters = new Set<() => void>();
  const endpoint = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(
        Buffer.concat(chunks).toString(),
      ) as TargetRequest;
      requests.push(input);
      for (const check of waiters) check();
      response.setHeader("Content-Type", "application/json");
      reply(
        input,
        response,
        requests.filter((item) => item.questionId === input.questionId).length,
      );
    })().catch((error: unknown) => {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise<void>((resolve) =>
    endpoint.listen(0, "127.0.0.1", resolve),
  );
  cleanups.push(async () => {
    endpoint.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      endpoint.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = endpoint.address();
  if (!address || typeof address === "string")
    throw new Error("The fixture endpoint has no TCP address.");
  let runtime = createRuntime({ stateDirectory: directory });
  let app = await createApplication({
    dataDirectory: directory,
    runtime,
  });
  cleanups.push(() => app.close());
  let api = await startServer({
    application: app,
    port: 0,
    host: "127.0.0.1",
  });
  cleanups.push(() => api.close());
  async function request(operation: CommandName, input: unknown) {
    const response = await fetch(`${api.url}/api/commands/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  }
  async function command<K extends CommandName>(
    operation: K,
    input: CommandInput<K>,
  ): Promise<CommandResultMap[K]> {
    const response = await request(operation, input);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body as CommandResultMap[K];
  }
  return {
    command,
    request,
    requests,
    get runtime() {
      return runtime;
    },
    directory,
    close: () => api.close(),
    restart: async () => {
      await api.close();
      runtime = createRuntime({ stateDirectory: directory });
      app = await createApplication({
        dataDirectory: directory,
        runtime,
      });
      api = await startServer({ application: app, port: 0, host: "127.0.0.1" });
    },
    waitForIdle: () => app.waitForIdle(),
    awaitRequests: (count: number) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`Expected ${count} local target requests.`));
        }, 5000);
        const check = () => {
          if (requests.length >= count) {
            clearTimeout(timer);
            waiters.delete(check);
            resolve();
          }
        };
        waiters.add(check);
        check();
      }),
    target: {
      kind: "external" as const,
      adapterId: "http",
      adapterVersion: 1,
      name: "Local recovery fixture",
      configuration: httpTargetSchema.parse({
        endpoint: `http://127.0.0.1:${address.port}`,
        body: { questionId: null, runId: null, attemptId: null },
        bindings: [
          { pointer: "/questionId", source: "questionId" },
          { pointer: "/runId", source: "runId" },
          { pointer: "/attemptId", source: "attemptId" },
        ],
      }),
    },
  };
}

function resolutionBarrier(runtime: RuntimePort) {
  let entered!: () => void;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const resolveTarget = runtime.resolveTarget.bind(runtime);
  let first = true;
  runtime.resolveTarget = async (target) => {
    if (first) {
      first = false;
      entered();
      await gate;
    }
    return resolveTarget(target);
  };
  return { pending, release };
}

it.each([false, true])(
  "preserves a newer Halt during delayed Resume with identical Run bytes; same receipt=%s",
  async (sameReceipt) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T00:00:00.000Z"));
    const f = await fixture(() => {});
    const bank = await f.command("banks.create", {
      name: "Resume freshness",
      questions: [{ id: "q", text: "Answer", expected: 42 }],
    });
    const launch = await f.command("runs.launch", {
      bankRevisionId: bank.id,
      target: f.target,
    });
    const runId = launch.run.id;
    await f.awaitRequests(1);
    await f.command("runs.control", { runId, action: "halt" });
    await f.waitForIdle();
    const before = await f.command("runs.get", { runId });
    const barrier = resolutionBarrier(f.runtime);
    const input = {
      runId,
      action: "resume" as const,
      expectedExecutionId: before.run.execution!.id,
      acknowledgeDuplicateWork: true,
      idempotencyKey: "resume-a",
    };
    const delayed = f.request("runs.control", input);
    try {
      await barrier.pending;
      await f.command("runs.control", {
        ...input,
        idempotencyKey: sameReceipt ? input.idempotencyKey : "resume-b",
      });
      await f.awaitRequests(2);
      await f.command("runs.control", { runId, action: "halt" });
      await f.waitForIdle();
      expect((await f.command("runs.get", { runId })).run).toEqual(before.run);
    } finally {
      barrier.release();
    }
    const result = await delayed;
    expect(result.status).toBe(sameReceipt ? 200 : 409);
    expect((await f.command("runs.get", { runId })).run.status).toBe("halted");
    expect(f.requests).toHaveLength(2);
  },
);

it.each([false, true])(
  "rejects a delayed failed-slot admission across Resume and Halt with identical Run bytes; execution guard=%s",
  async (guarded) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T00:00:00.000Z"));
    const f = await fixture((request, response) => {
      if (request.questionId !== "failed") return;
      response.statusCode = 503;
      response.end(JSON.stringify({ error: "Fixture failure" }));
    });
    const bank = await f.command("banks.create", {
      name: "Recovery freshness",
      questions: ["failed", "unfinished"].map((id) => ({
        id,
        text: id,
        expected: 42,
      })),
    });
    const launch = await f.command("runs.launch", {
      bankRevisionId: bank.id,
      target: f.target,
    });
    const runId = launch.run.id;
    await f.awaitRequests(2);
    await f.command("runs.control", { runId, action: "halt" });
    await f.waitForIdle();
    const before = await f.command("runs.get", { runId });
    expect(before.retryEligibility?.available).toBe(true);
    const barrier = resolutionBarrier(f.runtime);
    const delayed = f.request("runs.retry-failed", {
      runId,
      ...(guarded ? { expectedExecutionId: before.run.execution!.id } : {}),
      acknowledgeDuplicateWork: true,
      idempotencyKey: "retry-a",
    });
    try {
      await barrier.pending;
      await f.command("runs.control", {
        runId,
        action: "resume",
        acknowledgeDuplicateWork: true,
        expectedExecutionId: before.run.execution!.id,
        idempotencyKey: "resume-b",
      });
      await f.awaitRequests(3);
      await f.command("runs.control", { runId, action: "halt" });
      await f.waitForIdle();
      const after = await f.command("runs.get", { runId });
      expect(after.run).toEqual(before.run);
      expect(after.retryEligibility?.available).toBe(true);
    } finally {
      barrier.release();
    }
    expect((await delayed).status).toBe(409);
    expect((await f.command("runs.get", { runId })).run.status).toBe("halted");
    expect(f.requests).toHaveLength(3);
  },
);

it("recovers the original Run and saves a full automatic score without changing completed answers or saved scores", async () => {
  const f = await fixture((request, response, questionAttempt) => {
    if (request.questionId === "failed" && questionAttempt === 1) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: "Fixture execution failure" }));
      return;
    }
    response.end(
      JSON.stringify({ answer: request.questionId === "incorrect" ? 41 : 42 }),
    );
  });
  const bank = await f.command("banks.create", {
    name: "Recovery evidence",
    questions: ["correct", "incorrect", "failed"].map((id) => ({
      id,
      text: `Answer ${id}`,
      expected: 42,
    })),
  });
  const launch = await f.command("runs.launch", {
    bankRevisionId: bank.id,
    target: f.target,
    limits: { concurrency: 1, timeoutMs: 10000 },
  });
  const runId = launch.run.id;
  await f.waitForIdle();
  const before = await f.command("runs.get", { runId });
  expect(before.run.status).toBe("completed");
  expect(before.results.map((result) => result.status)).toEqual([
    "completed",
    "completed",
    "failed",
  ]);
  expect(before.progress).toEqual({ completed: 2, failed: 1, total: 3 });
  const original = before.assessmentPasses!.find(
    (pass) => pass.source === "deterministic",
  )!;
  expect(original.coverage).toMatchObject({
    answered: 2,
    judged: 2,
    correct: 1,
  });
  expect(original.accuracy).toBe(1 / 2);
  const custom = await f.command("runs.assess", {
    runId,
    name: "Saved custom rules",
    source: "deterministic",
  });
  const failed = before.results.find(
    (result) => result.questionId === "failed",
  )!;
  const human = await f.command("runs.review-assessment", {
    runId,
    parentPassId: custom.id,
    name: "Saved human notes",
    reviewer: "Fixture reviewer",
    overrides: [
      {
        resultId: failed.id,
        verdict: null,
        note: "Retain this execution note.",
      },
    ],
  });
  const saved = await f.command("runs.get", { runId });
  expect(saved.assessmentPasses!.map((pass) => pass.id)).toEqual(
    expect.arrayContaining([original.id, custom.id, human.id]),
  );
  const savedPasses = await Promise.all(
    saved.assessmentPasses!.map((pass) =>
      f.command("runs.export-assessment", { runId, passId: pass.id }),
    ),
  );
  const physicalAttempts = await Promise.all(
    before.attempts.map((attempt) =>
      f.command("runs.attempt", { runId, attemptId: attempt.id }),
    ),
  );
  expect(f.requests.map((request) => request.questionId)).toEqual([
    "correct",
    "incorrect",
    "failed",
  ]);

  const receipt = await f.command("runs.retry-failed", {
    runId,
    acknowledgeDuplicateWork: true,
    idempotencyKey: "recover-original",
  });
  await f.waitForIdle();
  expect(f.requests.map((request) => request.questionId)).toEqual([
    "correct",
    "incorrect",
    "failed",
    "failed",
  ]);
  expect(receipt.run.id).toBe(runId);
  expect(f.requests.every((request) => request.runId === runId)).toBe(true);
  const after = await f.command("runs.get", { runId });
  expect(after.run.manifest).toEqual(before.run.manifest);
  expect(after.results.map((result) => result.id)).toEqual(
    before.results.map((result) => result.id),
  );
  expect(after.progress).toEqual({ completed: 3, failed: 0, total: 3 });
  expect(after.attempts).toHaveLength(4);
  for (const attempt of before.attempts)
    expect(after.attempts.find((item) => item.id === attempt.id)).toEqual(
      attempt,
    );
  const recovered = after.results.find((result) => result.id === failed.id)!;
  expect(recovered.attemptIds.slice(0, -1)).toEqual(failed.attemptIds);
  expect(recovered.attemptIds).toHaveLength(2);
  expect(
    after.attempts
      .filter((attempt) => attempt.resultId === failed.id)
      .map((attempt) => ({
        number: attempt.number,
        runId: attempt.runId,
        resultId: attempt.resultId,
        status: attempt.status,
      })),
  ).toEqual([
    { number: 1, runId, resultId: failed.id, status: "failed" },
    { number: 2, runId, resultId: failed.id, status: "completed" },
  ]);
  for (const detail of physicalAttempts)
    expect(
      (await f.command("runs.attempt", { runId, attemptId: detail.attempt.id }))
        .attempt,
    ).toEqual(detail.attempt);
  for (const pass of savedPasses)
    expect(
      await f.command("runs.export-assessment", { runId, passId: pass.id }),
    ).toEqual(pass);
  const automatic = after.assessmentPasses!.find(
    (pass) =>
      pass.source === "deterministic" &&
      !savedPasses.some((previous) => previous.id === pass.id),
  )!;
  expect(automatic).toBeDefined();
  expect(automatic.basis.eligibleResultIds).toEqual(
    before.results.map((result) => result.id),
  );
  expect(automatic.coverage).toMatchObject({
    eligible: 3,
    answered: 3,
    judged: 3,
    correct: 2,
    incorrect: 1,
  });
  expect(automatic.accuracy).toBe(2 / 3);
  expect(
    automatic.judgments.find((item) => item.resultId === failed.id),
  ).toMatchObject({
    attemptId: recovered.completedAttemptId,
    status: "correct",
  });
});

it("completes a fully answered Run when its final HTTP answer drains under Pause", async () => {
  let response!: ServerResponse;
  const f = await fixture((_request, pending) => {
    response = pending;
  });
  const bank = await f.command("banks.create", {
    name: "Final answer drain",
    questions: [{ id: "q", text: "Answer", expected: 42 }],
  });
  const launched = await f.command("runs.launch", {
    bankRevisionId: bank.id,
    target: f.target,
  });
  const runId = launched.run.id;
  await f.awaitRequests(1);
  await f.command("runs.control", { runId, action: "pause" });
  response.end(JSON.stringify({ answer: 42 }));
  await f.waitForIdle();
  const completed = await f.command("runs.get", { runId });
  expect(completed.run.status).toBe("completed");
  expect(completed.run.execution?.id).toBe(runId);
  expect(completed.run.execution?.settledAt).toBeDefined();
  expect(completed.progress).toEqual({ completed: 1, failed: 0, total: 1 });
  expect(completed.allowedActions).toEqual([]);
  expect(completed.assessmentPasses!.map((pass) => pass.id)).toEqual([
    `original_deterministic_${runId}`,
  ]);
  expect(f.requests).toHaveLength(1);
});

it("recovers only the requested failed subset while leaving other failed, interrupted, and never-started slots untouched", async () => {
  const f = await fixture((request, response, questionAttempt) => {
    if (request.questionId === "interrupted") return;
    if (request.questionId.startsWith("failed") && questionAttempt === 1) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: "Fixture execution failure" }));
      return;
    }
    response.end(JSON.stringify({ answer: 42 }));
  });
  const bank = await f.command("banks.create", {
    name: "Bounded recovery selection",
    questions: [
      "failed-selected",
      "failed-other",
      "interrupted",
      "never-started",
    ].map((id) => ({ id, text: `Answer ${id}`, expected: 42 })),
  });
  const launch = await f.command("runs.launch", {
    bankRevisionId: bank.id,
    target: f.target,
    limits: { concurrency: 1, timeoutMs: 10000 },
  });
  const runId = launch.run.id;
  await f.awaitRequests(3);
  await f.command("runs.control", { runId, action: "halt" });
  await f.waitForIdle();
  const before = await f.command("runs.get", { runId });
  expect(before.run.status).toBe("halted");
  expect(before.results.map((result) => result.status)).toEqual([
    "failed",
    "failed",
    "interrupted",
    "pending",
  ]);
  const selected = before.results.find(
    (result) => result.questionId === "failed-selected",
  )!;

  const receipt = await f.command("runs.retry-failed", {
    runId,
    resultIds: [selected.id],
    acknowledgeDuplicateWork: true,
    idempotencyKey: "recover-selected-only",
  });
  await f.waitForIdle();
  expect(f.requests.map((request) => request.questionId)).toEqual([
    "failed-selected",
    "failed-other",
    "interrupted",
    "failed-selected",
  ]);
  expect(receipt.run.id).toBe(runId);
  const after = await f.command("runs.get", { runId });
  expect(after.run.manifest).toEqual(before.run.manifest);
  expect(
    after.results.find((result) => result.id === selected.id),
  ).toMatchObject({
    status: "completed",
    attemptIds: [selected.attemptIds[0], f.requests[3]!.attemptId],
  });
  for (const result of before.results.filter((item) => item.id !== selected.id))
    expect(after.results.find((item) => item.id === result.id)).toEqual(result);
  expect(after.progress).toEqual({ completed: 1, failed: 1, total: 4 });
  expect(after.run.status).toBe("halted");
});

it("admits concurrent identical recovery once and replays its receipt after Halt without restarting work", async () => {
  const f = await fixture((_request, response, attempt) => {
    if (attempt === 2) return;
    response.statusCode = attempt === 1 ? 503 : 200;
    response.end(JSON.stringify({ answer: 42 }));
  });
  const bank = await f.command("banks.create", {
    name: "Recovery admission",
    questions: [{ id: "q", text: "Answer", expected: 42 }],
  });
  const launched = await f.command("runs.launch", {
    bankRevisionId: bank.id,
    target: f.target,
  });
  const runId = launched.run.id;
  await f.waitForIdle();
  const input = {
    runId,
    acknowledgeDuplicateWork: true,
    idempotencyKey: "one-recovery",
  };
  const receipts = await Promise.all([
    f.command("runs.retry-failed", input),
    f.command("runs.retry-failed", input),
  ]);
  expect(receipts.map((value) => value.run.id)).toEqual([runId, runId]);
  await f.awaitRequests(2);
  const conflict = await f.request("runs.retry-failed", {
    ...input,
    idempotencyKey: "competing-recovery",
  });
  expect(conflict).toMatchObject({
    status: 409,
    body: { error: { code: "invalid_state" } },
  });
  await f.command("runs.control", { runId, action: "halt" });
  await f.waitForIdle();
  const replay = await f.command("runs.retry-failed", input);
  expect(replay.run.status).toBe("halted");
  expect(f.requests).toHaveLength(2);
  const withoutAck = await f.request("runs.control", {
    runId,
    action: "resume",
    idempotencyKey: "resume-once",
  });
  expect(withoutAck.body).toMatchObject({
    error: { code: "duplicate_work_acknowledgment_required" },
  });
  const resume = {
    runId,
    action: "resume" as const,
    acknowledgeDuplicateWork: true,
    idempotencyKey: "resume-once",
  };
  await f.command("runs.control", resume);
  await f.waitForIdle();
  await f.command("runs.control", resume);
  expect(f.requests).toHaveLength(3);
  expect((await f.command("runs.get", { runId })).progress.completed).toBe(1);
});

it("keeps cancellation terminal even when the Run contains a failed slot", async () => {
  const f = await fixture((request, response) => {
    if (request.questionId === "active") return;
    response.statusCode = 503;
    response.end(JSON.stringify({ error: "Fixture failure" }));
  });
  const bank = await f.command("banks.create", {
    name: "Cancelled recovery",
    questions: ["failed", "active"].map((id) => ({
      id,
      text: id,
      expected: 42,
    })),
  });
  const launched = await f.command("runs.launch", {
    bankRevisionId: bank.id,
    target: f.target,
  });
  const runId = launched.run.id;
  await f.awaitRequests(2);
  await f.command("runs.control", { runId, action: "cancel" });
  await f.waitForIdle();
  const rejected = await f.request("runs.retry-failed", {
    runId,
    acknowledgeDuplicateWork: true,
    idempotencyKey: "after-cancel",
  });
  expect(rejected).toMatchObject({
    status: 409,
    body: { error: { code: "invalid_state" } },
  });
  expect((await f.command("runs.get", { runId })).run.status).toBe("cancelled");
  expect(f.requests).toHaveLength(2);
});

it("requires acknowledgment for an uncertain failed dispatch and rejects completed answers and stale execution actions", async () => {
  const f = await fixture((request, response, attempt) => {
    response.statusCode =
      request.questionId === "failed" && attempt === 1 ? 503 : 200;
    response.end(JSON.stringify({ answer: 41 }));
  });
  const bank = await f.command("banks.create", {
    name: "Recovery safety",
    questions: ["incorrect", "failed"].map((id) => ({
      id,
      text: id,
      expected: 42,
    })),
  });
  const launched = await f.command("runs.launch", {
    bankRevisionId: bank.id,
    target: f.target,
  });
  const runId = launched.run.id;
  await f.waitForIdle();
  const before = await f.command("runs.get", { runId });
  const wrong = before.results.find(
    (result) => result.questionId === "incorrect",
  )!;
  const missingAck = await f.request("runs.retry-failed", {
    runId,
    idempotencyKey: "needs-ack",
  });
  expect(missingAck.body).toMatchObject({
    error: { code: "duplicate_work_acknowledgment_required" },
  });
  const completed = await f.request("runs.retry-failed", {
    runId,
    resultIds: [wrong.id],
    acknowledgeDuplicateWork: true,
    idempotencyKey: "wrong-answer",
  });
  expect(completed.body).toMatchObject({ error: { code: "invalid_input" } });
  const stale = await f.request("runs.retry-failed", {
    runId,
    acknowledgeDuplicateWork: true,
    idempotencyKey: "stale-action",
    expectedExecutionId: "obsolete-execution",
  });
  expect(stale).toMatchObject({
    status: 409,
    body: { error: { code: "conflict" } },
  });
  expect(f.requests).toHaveLength(2);
});

it("preserves an interrupted recovery scope across restart and creates a new continuation only after that scope settles", async () => {
  const f = await fixture((request, response, attempt) => {
    if (
      (request.questionId === "failed" && attempt === 2) ||
      (request.questionId === "interrupted" && attempt === 1)
    )
      return;
    response.statusCode =
      request.questionId === "failed" && attempt === 1 ? 503 : 200;
    response.end(JSON.stringify({ answer: 42 }));
  });
  const bank = await f.command("banks.create", {
    name: "Restarted selection",
    questions: ["failed", "interrupted", "never-started"].map((id) => ({
      id,
      text: id,
      expected: 42,
    })),
  });
  const launched = await f.command("runs.launch", {
    bankRevisionId: bank.id,
    target: f.target,
    limits: { concurrency: 1 },
  });
  const runId = launched.run.id;
  await f.awaitRequests(2);
  await f.command("runs.control", { runId, action: "halt" });
  await f.waitForIdle();
  const input = {
    runId,
    acknowledgeDuplicateWork: true,
    idempotencyKey: "interrupted-recovery",
  };
  const recovery = await f.command("runs.retry-failed", input);
  await f.awaitRequests(3);
  await f.command("runs.control", { runId, action: "halt" });
  await f.waitForIdle();
  const paused = await f.command("runs.get", { runId });
  expect(paused.run.execution?.id).toBe(recovery.run.execution!.id);
  expect(paused.run.execution?.settledAt).toBeUndefined();
  const elapsed = paused.performance!.durationMs;
  await f.restart();
  const replay = await f.command("runs.retry-failed", input);
  expect(replay.run.status).toBe("halted");
  expect(f.requests).toHaveLength(3);
  const reopened = await f.command("runs.get", { runId });
  expect(reopened.performance!.durationMs).toBe(elapsed);
  expect(reopened.resumeEligibility).toMatchObject({
    available: true,
    resultIds: recovery.run.execution!.resultIds,
    requiresAcknowledgment: true,
  });
  await f.command("runs.control", {
    runId,
    action: "resume",
    acknowledgeDuplicateWork: true,
    idempotencyKey: "finish-recovery",
    expectedExecutionId: recovery.run.execution!.id,
  });
  await f.waitForIdle();
  const drained = await f.command("runs.get", { runId });
  expect(f.requests.map((request) => request.questionId)).toEqual([
    "failed",
    "interrupted",
    "failed",
    "failed",
  ]);
  expect(drained.run.execution?.id).toBe(recovery.run.execution!.id);
  expect(drained.run.execution?.settledAt).toBeDefined();
  expect(drained.run.execution?.stopReason).toBe("outside-scope-unfinished");
  await f.command("runs.control", {
    runId,
    action: "resume",
    acknowledgeDuplicateWork: true,
    idempotencyKey: "continue-remaining",
    expectedExecutionId: recovery.run.execution!.id,
  });
  await f.waitForIdle();
  const completed = await f.command("runs.get", { runId });
  expect(completed.run.execution?.id).not.toBe(recovery.run.execution!.id);
  expect(completed.run.status).toBe("completed");
  expect(completed.progress).toEqual({ completed: 3, failed: 0, total: 3 });
  expect(f.requests.map((request) => request.questionId)).toEqual([
    "failed",
    "interrupted",
    "failed",
    "failed",
    "interrupted",
    "never-started",
  ]);
});

it("protects a legacy applied completed answer even when an explicit selection names its still-failed physical result", async () => {
  let fail = true;
  const f = await fixture((_request, response) => {
    response.statusCode = fail ? 503 : 200;
    response.end(JSON.stringify({ answer: 42 }));
  });
  const bank = await f.command("banks.create", {
    name: "Legacy binding",
    questions: [{ id: "q", text: "Answer", expected: 42 }],
  });
  const original = await f.command("runs.launch", {
    bankRevisionId: bank.id,
    target: f.target,
  });
  await f.waitForIdle();
  const originalView = await f.command("runs.get", { runId: original.run.id });
  fail = false;
  const child = await f.command("runs.launch", {
    bankRevisionId: bank.id,
    target: f.target,
  });
  await f.waitForIdle();
  const childView = await f.command("runs.get", { runId: child.run.id });
  const logical = originalView.results[0]!;
  const physical = childView.results[0]!;
  await f.close();
  const db = new Database(join(f.directory, "workspace.sqlite"));
  try {
    const childRun = db.require("run", child.run.id);
    db.update("run", {
      ...childRun,
      retryOf: { runId: original.run.id, resultIds: [logical.id] },
    });
    db.insert("retryApplication", {
      id: "legacy-application",
      runId: original.run.id,
      retryRunId: child.run.id,
      createdAt: childRun.createdAt,
      bindings: [
        {
          resultId: logical.id,
          source: db.answerSource(physical.completedAttemptId!),
        },
      ],
      assessmentPassIds: [],
    });
    db.append({
      runId: child.run.id,
      attemptId: physical.completedAttemptId!,
      type: "agent.message",
      message: "Adopted physical activity",
      data: { complete: "retained adopted event data" },
    });
  } finally {
    db.close();
  }
  await f.restart();
  const reopened = await f.command("runs.get", { runId: original.run.id });
  expect(reopened.progress).toEqual({ completed: 1, failed: 0, total: 1 });
  expect(reopened.results[0]).toMatchObject({
    id: logical.id,
    status: "failed",
    answerSource: { attemptId: physical.completedAttemptId },
  });
  const adopted = {
    runId: original.run.id,
    attemptId: physical.completedAttemptId!,
  };
  const adoptedDetail = await f.command("runs.attempt", adopted);
  expect(adoptedDetail).not.toHaveProperty("events");
  expect(adoptedDetail.attempt.output?.answer).toBe(42);
  expect(adoptedDetail.attempt.runId).toBe(child.run.id);
  const adoptedEvents = await f.command("runs.attempt-events", adopted);
  expect(adoptedEvents).toEqual(
    await f.command("runs.attempt-events", { ...adopted, runId: child.run.id }),
  );
  expect(adoptedEvents.events).toContainEqual(
    expect.objectContaining({
      runId: child.run.id,
      attemptId: physical.completedAttemptId,
      message: "Adopted physical activity",
      data: { complete: "retained adopted event data" },
    }),
  );
  const rejected = await f.request("runs.retry-failed", {
    runId: original.run.id,
    resultIds: [logical.id],
    acknowledgeDuplicateWork: true,
    idempotencyKey: "already-answered",
  });
  expect(rejected.body).toMatchObject({ error: { code: "invalid_input" } });
  expect(f.requests).toHaveLength(2);
});

it("marks crash-interrupted timing incomplete instead of including engine downtime or resending a target", async () => {
  const f = await fixture(() => {});
  const bank = await f.command("banks.create", {
    name: "Interrupted timing",
    questions: [{ id: "q", text: "Answer", expected: 42 }],
  });
  const launched = await f.command("runs.launch", {
    bankRevisionId: bank.id,
    target: f.target,
  });
  const runId = launched.run.id;
  await f.awaitRequests(1);
  await f.command("runs.control", { runId, action: "halt" });
  await f.waitForIdle();
  await f.close();
  const db = new Database(join(f.directory, "workspace.sqlite"));
  try {
    const run = db.require("run", runId);
    const result = db.list("result", { runId })[0]!;
    const attempt = db.require("attempt", result.attemptIds[0]!);
    db.update("attempt", {
      ...attempt,
      status: "running",
      finishedAt: undefined,
      error: undefined,
    });
    db.update("result", { ...result, status: "running" });
    db.update("run", {
      ...run,
      status: "running",
      intent: "run",
      activeDurationMs: 120,
      execution: {
        ...run.execution!,
        activeSegmentStartedAt: "2026-11-01T00:00:00.000Z",
      },
    });
  } finally {
    db.close();
  }
  await f.restart();
  const recovered = await f.command("runs.get", { runId });
  expect(recovered.run.status).toBe("halted");
  expect(recovered.run.execution?.activeSegmentStartedAt).toBeUndefined();
  expect(recovered.performance).toMatchObject({
    durationMs: null,
    durationIncomplete: true,
  });
  expect(recovered.run.activeDurationMs).toBe(120);
  expect(f.requests).toHaveLength(1);
});

it("settles a crash after sealed answers only after recovering their deterministic scores", async () => {
  const f = await fixture((_request, response) =>
    response.end(JSON.stringify({ answer: 42 })),
  );
  const bank = await f.command("banks.create", {
    name: "Sealed startup recovery",
    questions: [{ id: "q", text: "Answer", expected: 42 }],
  });
  const launched = await f.command("runs.launch", {
    bankRevisionId: bank.id,
    target: f.target,
  });
  await f.waitForIdle();
  const saved = await f.command("runs.get", { runId: launched.run.id });
  const detail = await f.command("runs.attempt", {
    runId: launched.run.id,
    attemptId: saved.results[0]!.completedAttemptId!,
  });
  await f.close();
  const db = new Database(join(f.directory, "workspace.sqlite"));
  const runId = "sealed-before-settlement";
  try {
    db.insert("run", {
      ...saved.run,
      id: runId,
      status: "running",
      intent: "run",
      selectedAssessmentPassId: undefined,
      execution: {
        id: runId,
        resultIds: ["sealed-result"],
        controller: "run",
        createdAt: saved.run.createdAt,
        activeSegmentStartedAt: saved.run.createdAt,
      },
    });
    db.insert("result", {
      id: "sealed-result",
      runId,
      questionId: "q",
      repetition: 1,
      status: "completed",
      attemptIds: ["sealed-attempt"],
      completedAttemptId: "sealed-attempt",
    });
    db.insert("attempt", {
      ...detail.attempt,
      id: "sealed-attempt",
      executionId: runId,
      runId,
      resultId: "sealed-result",
    });
  } finally {
    db.close();
  }
  await f.restart();
  const recovered = await f.command("runs.get", { runId });
  expect(recovered.run.status).toBe("completed");
  expect(recovered.run.execution?.settledAt).toBeDefined();
  expect(recovered.assessmentPasses![0]!.coverage).toMatchObject({
    answered: 1,
    judged: 1,
    correct: 1,
  });
  expect(
    (await f.command("runs.events", { runId })).events.some(
      (event) => event.type === "evaluation.recovered",
    ),
  ).toBe(true);
  expect(f.requests).toHaveLength(1);
});
