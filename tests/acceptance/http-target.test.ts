import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createApplication } from "../../src/application/application.js";
import { createRuntime } from "../../src/runtime/index.js";
import { httpTargetSchema } from "../../src/contracts/http-target.js";
import { agentSchema, type Json } from "../../src/contracts.js";
import { startServer } from "../../src/server.js";
import { runCli } from "../../src/cli.js";
import { Database } from "../../src/storage/database.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(
  reply: (body: Json, index: number) => Json | undefined = () => ({
    answer: 42,
  }),
  status = 200,
) {
  const requests: Json[] = [];
  const responses: ServerResponse[] = [];
  const waiters = new Set<() => void>();
  const awaitRequests = (count: number) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`Expected ${count} HTTP requests.`));
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
    });
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const part of request) chunks.push(part);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Json;
      requests.push(body);
      responses.push(response);
      for (const check of waiters) check();
      response.statusCode = status;
      response.setHeader("Content-Type", "application/json");
      const result = reply(body, requests.length - 1);
      if (result !== undefined) response.end(JSON.stringify(result));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  const directory = await mkdtemp(join(tmpdir(), "aeh-http-e2e-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const runtime = createRuntime({ stateDirectory: directory });
  const app = await createApplication({ dataDirectory: directory, runtime });
  cleanup.push(() => app.close());
  const bank = await app.execute("banks.create", {
    name: "HTTP acceptance",
    questions: [{ id: "q", text: "Return the answer", expected: 42 }],
  });
  const target = {
    kind: "external" as const,
    adapterId: "http",
    adapterVersion: 1,
    name: "Endpoint fixture",
    configuration: httpTargetSchema.parse({
      endpoint: `http://127.0.0.1:${address.port}`,
    }),
  };
  return {
    app,
    directory,
    requests,
    bank,
    target,
    awaitRequests,
    respond: (index: number, value: Json = { answer: 42 }) =>
      responses[index]!.end(JSON.stringify(value)),
  };
}
it("evaluates a real HTTP response without local harness readiness and freezes target settings", async () => {
  const { app, directory, requests, bank, target } = await fixture();
  const profile = await app.execute("targets.save", {
    name: target.name,
    target,
  });
  const run = await app.execute("runs.launch", {
    name: "External",
    bankRevisionId: bank.id,
    target: profile.target,
    repetitions: 2,
  });
  await app.waitForIdle();
  const saved = await app.execute("runs.get", { runId: run.run.id });
  expect(saved.run.status).toBe("completed");
  expect(saved.progress.completed).toBe(2);
  expect(
    saved.assessmentPasses![0]?.judgments.every(
      (item) => item.status === "correct",
    ),
  ).toBe(true);
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests)).not.toContain('"expected"');
  expect(saved.run.manifest).not.toHaveProperty("agent");
  expect(await readdir(directory)).not.toContain("process-scopes");
  const blueprint = await app.execute("blueprints.save", {
    name: "HTTP blueprint",
    runId: run.run.id,
  });
  expect(blueprint.target).toEqual(saved.run.manifest.target);
  const exported = await app.execute("runs.export-target", {
    runId: run.run.id,
  });
  expect(exported).toMatchObject({ scope: "external-invocation" });
  await app.execute("targets.delete", { targetId: profile.id });
  expect(
    (await app.execute("runs.get", { runId: run.run.id })).run.manifest,
  ).toEqual(saved.run.manifest);
});
it("drains admitted requests on pause and resumes only unfinished questions", async () => {
  const { app, bank, target, requests, awaitRequests, respond } = await fixture(
    (_body, index) => (index === 0 ? undefined : { answer: 42 }),
  );
  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    target,
    repetitions: 2,
  });
  await awaitRequests(1);
  await app.execute("runs.control", {
    runId: launched.run.id,
    action: "pause",
  });
  expect(
    (await app.execute("runs.get", { runId: launched.run.id })).run.status,
  ).toBe("pausing");
  respond(0);
  await app.waitForIdle();
  const paused = await app.execute("runs.get", { runId: launched.run.id });
  expect(paused.run.status).toBe("paused");
  expect(paused.progress.completed).toBe(1);
  expect(requests).toHaveLength(1);
  await app.execute("runs.control", {
    runId: launched.run.id,
    action: "resume",
  });
  await app.waitForIdle();
  expect(requests).toHaveLength(2);
  expect(
    (await app.execute("runs.get", { runId: launched.run.id })).progress
      .completed,
  ).toBe(2);
});
it("requires explicit duplicate-work acknowledgment after halting a dispatched request", async () => {
  const { app, bank, target, requests, awaitRequests } = await fixture(
    (_body, index) => (index === 0 ? undefined : { answer: 42 }),
  );
  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    target,
  });
  await awaitRequests(1);
  await app.execute("runs.control", { runId: launched.run.id, action: "halt" });
  await app.waitForIdle();
  const halted = await app.execute("runs.get", { runId: launched.run.id });
  expect(halted.run.status).toBe("halted");
  expect(halted.attempts[0]?.remoteCompletion).toBe("unknown");
  await expect(
    app.execute("runs.control", { runId: launched.run.id, action: "resume" }),
  ).rejects.toMatchObject({ code: "duplicate_work_acknowledgment_required" });
  expect(requests).toHaveLength(1);
  await app.execute("runs.control", {
    runId: launched.run.id,
    action: "resume",
    acknowledgeDuplicateWork: true,
  });
  await app.waitForIdle();
  const completed = await app.execute("runs.get", { runId: launched.run.id });
  expect(completed.run.status).toBe("completed");
  expect(completed.attempts).toHaveLength(2);
  expect(new Set(completed.attempts.map((attempt) => attempt.id)).size).toBe(2);
});
it("cancels locally without claiming that remote work stopped", async () => {
  const { app, bank, target, requests, awaitRequests, respond } = await fixture(
    () => undefined,
  );
  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    target,
  });
  await awaitRequests(1);
  await app.execute("runs.control", {
    runId: launched.run.id,
    action: "cancel",
  });
  await app.waitForIdle();
  respond(0);
  const cancelled = await app.execute("runs.get", { runId: launched.run.id });
  expect(cancelled.run.status).toBe("cancelled");
  expect(cancelled.attempts[0]?.remoteCompletion).toBe("unknown");
  expect(cancelled.progress.completed).toBe(0);
  expect(requests).toHaveLength(1);
});
it("does not retry protocol errors or count them as incorrect answers", async () => {
  const { app, bank, target, requests } = await fixture(
    () => ({ answer: 42 }),
    429,
  );
  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    target,
  });
  await app.waitForIdle();
  const failed = await app.execute("runs.get", { runId: launched.run.id });
  expect(failed.attempts[0]?.status).toBe("failed");
  expect(failed.progress.completed).toBe(0);
  expect(failed.assessmentPasses![0]?.coverage.answered).toBe(0);
  expect(requests).toHaveLength(1);
});
it("recovers a dispatched crash checkpoint without resending uncertain work", async () => {
  const { app, directory, bank, target, requests, awaitRequests } =
    await fixture(() => undefined);
  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    target,
  });
  await awaitRequests(1);
  await app.execute("runs.control", { runId: launched.run.id, action: "halt" });
  await app.waitForIdle();
  await app.close();
  // Restore the durable pre-settlement state to model process death after dispatch.
  const db = new Database(join(directory, "workspace.sqlite"));
  const attempt = db.list("attempt", { runId: launched.run.id })[0]!;
  db.update("attempt", {
    ...attempt,
    status: "running",
    finishedAt: undefined,
    error: undefined,
  });
  const result = db.require("result", attempt.resultId);
  db.update("result", { ...result, status: "running" });
  const run = db.require("run", launched.run.id);
  db.update("run", { ...run, status: "running", intent: "run" });
  db.close();
  const restarted = await createApplication({
    dataDirectory: directory,
    runtime: createRuntime({ stateDirectory: directory }),
  });
  cleanup.push(() => restarted.close());
  const recovered = await restarted.execute("runs.get", {
    runId: launched.run.id,
  });
  expect(recovered.run.status).toBe("halted");
  expect(recovered.attempts[0]?.remoteCompletion).toBe("unknown");
  expect(requests).toHaveLength(1);
  await expect(
    restarted.execute("runs.control", {
      runId: launched.run.id,
      action: "resume",
    }),
  ).rejects.toMatchObject({ code: "duplicate_work_acknowledgment_required" });
});
it("keeps incorrect returned answers as grading failures, not request errors", async () => {
  const { app, bank, target } = await fixture(() => ({ answer: 41 }));
  const run = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    target,
  });
  await app.waitForIdle();
  const saved = await app.execute("runs.get", { runId: run.run.id });
  expect(saved.progress.completed).toBe(1);
  expect(saved.assessmentPasses![0]?.judgments[0]?.status).toBe("incorrect");
});

it("rejects external research before any endpoint request", async () => {
  const { app, bank, target, requests } = await fixture();
  await expect(
    app.execute("research.start", {
      name: "Unsupported",
      baseline: { bankRevisionId: bank.id, target },
      researcher: agentSchema.parse({ harness: "codex", model: "fixture" }),
      objective: "Improve answer quality",
    }),
  ).rejects.toThrow(/managed|external|research/i);
  expect(requests).toHaveLength(0);
});

it("excludes private references and criteria from endpoint requests and configuration exports", async () => {
  const { app, target, requests } = await fixture();
  const bank = await app.execute("banks.create", {
    name: "Private basis",
    questions: [
      {
        id: "private",
        text: "Public question",
        context: "Public context",
        expected: "PRIVATE_GOLD_MARKER",
      },
    ],
  });
  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    target,
  });
  await app.waitForIdle();
  const exported = await app.execute("runs.export-target", {
    runId: launched.run.id,
  });
  expect(JSON.stringify(requests)).not.toContain("PRIVATE_GOLD_MARKER");
  expect(JSON.stringify(exported)).not.toContain("PRIVATE_GOLD_MARKER");
  expect(requests[0]).toMatchObject({
    question: "Public question",
    context: "Public context",
  });
});

it("times out a dispatched request without an implicit retry", async () => {
  const { app, bank, target, requests } = await fixture(() => undefined);
  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    target,
    limits: { timeoutMs: 1000 },
  });
  await app.waitForIdle();
  const saved = await app.execute("runs.get", { runId: launched.run.id });
  expect(saved.attempts[0]?.status).toBe("failed");
  expect(saved.attempts[0]?.remoteCompletion).toBe("unknown");
  expect(requests).toHaveLength(1);
});

it("preserves an invalid public-format response as a completed incorrect answer", async () => {
  const { app, target } = await fixture();
  const bank = await app.execute("banks.create", {
    name: "Public format",
    questions: [
      {
        id: "typed",
        text: "Return text",
        expected: "42",
        answerFormat: { type: "scalar", valueType: "string", nullable: false },
      },
    ],
  });
  const started = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    target,
  });
  await app.waitForIdle();
  const saved = await app.execute("runs.get", { runId: started.run.id });
  expect(saved.run.status).toBe("completed");
  expect(saved.progress.completed).toBe(1);
  expect(saved.assessmentPasses![0]?.judgments[0]?.status).toBe("incorrect");
  const detail = await app.execute("runs.attempt", {
    runId: started.run.id,
    attemptId: saved.attempts[0]!.id,
  });
  expect(detail.attempt.output?.answer).toBe(42);
  expect(detail.assessments[0]?.assessment.deterministic).toMatchObject({
    status: "incorrect",
    details: { reason: "public_format" },
  });
});

it("shutdown cancels an admitted sample instead of waiting for its request deadline", async () => {
  const { app, target, awaitRequests } = await fixture(() => undefined);
  const sample = app.execute("targets.sample", {
    target,
    question: { id: "sample", text: "Wait" },
    timeoutMs: 120000,
  });
  const rejected = expect(sample).rejects.toThrow();
  await awaitRequests(1);
  await Promise.race([
    app.close(),
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Sample shutdown exceeded 3 seconds")),
        3000,
      );
      timer.unref();
    }),
  ]);
  await rejected;
});

it("uses the same external target workflow through CLI and HTTP", async () => {
  const { app, target, bank } = await fixture();
  const server = await startServer({ application: app, port: 0 });
  cleanup.push(() => server.close());
  const discovery = (await runCli(["discover", "--url", server.url])) as {
    operations: Array<{ name: string }>;
  };
  expect(
    discovery.operations.some((item) => item.name === "targets.sample"),
  ).toBe(true);
  const launched = (await runCli([
    "runs.launch",
    "--url",
    server.url,
    "--json",
    JSON.stringify({ target, bankRevisionId: bank.id }),
  ])) as { run: { id: string } };
  await app.waitForIdle();
  const inspected = (await runCli([
    "runs.get",
    "--url",
    server.url,
    "--json",
    JSON.stringify({ runId: launched.run.id }),
  ])) as { run: { status: string } };
  expect(inspected.run.status).toBe("completed");
  const exported = (await runCli([
    "runs.export-target",
    "--url",
    server.url,
    "--json",
    JSON.stringify({ runId: launched.run.id }),
  ])) as { scope: string };
  expect(exported.scope).toBe("external-invocation");
});
