import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { targetFixture } from "../../tests/fixtures/runtime-targets.js";
import {
  researchSchema,
  type AgentConfig,
  type ResearchView,
  type RuntimePort,
} from "../contracts.js";
import { digest } from "../domain/identity.js";
import { Database } from "../storage/database.js";
import { startServer } from "../server.js";
import { createApplication } from "./application.js";

const agent: AgentConfig = {
  harness: "codex",
  model: "fixture",
  systemPrompt: "Answer",
  settings: {},
  tools: [],
  connections: [],
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "aeh-research-launch-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const execute = vi.fn(async () => ({ answer: 42, text: "42" }));
  const researcher = vi.fn(async () => ({
    conversationId: "fixture-conversation",
    message: "Fixture research complete",
    control: "stop" as const,
  }));
  const runtime: RuntimePort = {
    ...targetFixture,
    execute,
    researcher,
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
    testConnection: async () => ({ ok: true, message: "ok" }),
    judge: async () => {
      throw new Error("Unused");
    },
  };
  const app = await createApplication({ dataDirectory: directory, runtime });
  cleanups.push(() => app.close());
  const bank = await app.execute<"banks.create">("banks.create", {
    name: "Fixture",
    questions: [{ id: "q1", text: "Count?", expected: 42 }],
  });
  const input = researchSchema.parse({
    name: "One baseline",
    baseline: { bankRevisionId: bank.id, agent },
    researcher: agent,
    objective: "Accuracy",
    maxCandidates: 1,
    maxTargetInvocations: 1,
    idempotencyKey: "stable-launch",
  });
  return { directory, app, runtime, execute, researcher, input };
}

it("returns one complete baseline receipt to concurrent HTTP retries while target resolution waits", async () => {
  const { app, runtime, execute, researcher, input } = await setup();
  const entered = deferred();
  const release = deferred();
  const resolveTarget = vi.fn(
    async (target: Parameters<RuntimePort["resolveTarget"]>[0]) => {
      entered.resolve();
      await release.promise;
      return targetFixture.resolveTarget.call(runtime, target);
    },
  );
  runtime.resolveTarget = resolveTarget;
  const server = await startServer({
    application: app,
    host: "127.0.0.1",
    port: 0,
  });
  cleanups.push(() => server.close());
  const post = async () => {
    const response = await fetch(`${server.url}/api/commands/research.launch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(response.ok).toBe(true);
    return (await response.json()) as ResearchView;
  };
  const first = post();
  try {
    await entered.promise;
    const secondReceived = deferred();
    server.server.once("request", (request) =>
      request.once("end", () => setImmediate(() => secondReceived.resolve())),
    );
    const second = post();
    await secondReceived.promise;
    release.resolve();
    const [original, retried] = await Promise.all([first, second]);
    expect(original.session.currentRunId).not.toBe("");
    expect(retried.session.currentRunId).toBe(original.session.currentRunId);
    expect(retried.session.id).toBe(original.session.id);
    expect(retried.session.baselineRunId).toBe(original.session.baselineRunId);
    await app.waitForIdle();
    expect(resolveTarget).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(researcher).toHaveBeenCalledTimes(1);
    expect(
      (await app.execute<"workspace.get">("workspace.get", {}))
        .researchSessions,
    ).toHaveLength(1);
  } finally {
    release.resolve();
    await first;
  }
});

it("rejects replay of a restarted initialization without a baseline instead of returning an empty Run ID", async () => {
  const { directory, app, runtime, execute, researcher, input } = await setup();
  await app.close();
  const db = new Database(join(directory, "workspace.sqlite"));
  db.insert("research", {
    id: "interrupted-init",
    name: input.name,
    createdAt: "2026-10-22",
    updatedAt: "2026-10-22",
    status: "queued",
    intent: "run",
    configuration: input,
    baselineRunId: "",
    currentRunId: "",
    bestRunId: "",
    runIds: [],
    phase: "baseline",
    turns: [],
  });
  db.remember(
    `research:${input.idempotencyKey}`,
    digest(input),
    "research",
    "interrupted-init",
  );
  db.close();
  const restarted = await createApplication({
    dataDirectory: directory,
    runtime,
  });
  cleanups.push(() => restarted.close());
  await expect(
    restarted.execute<"research.launch">("research.launch", input),
  ).rejects.toMatchObject({ code: "launch_incomplete" });
  expect(
    (
      await restarted.execute<"research.get">("research.get", {
        sessionId: "interrupted-init",
      })
    ).session,
  ).toMatchObject({ status: "failed", currentRunId: "" });
  expect(execute).not.toHaveBeenCalled();
  expect(researcher).not.toHaveBeenCalled();
});

it("reconnects a committed baseline after restart without repeating target work", async () => {
  const { directory, app, runtime, execute, researcher, input } = await setup();
  const original = await app.execute<"research.launch">(
    "research.launch",
    input,
  );
  await app.waitForIdle();
  const priorResearcherCalls = researcher.mock.calls.length;
  await app.close();
  const db = new Database(join(directory, "workspace.sqlite"));
  const session = db.require("research", original.session.id);
  db.update("research", {
    ...session,
    status: "queued",
    intent: "run",
    baselineRunId: "",
    currentRunId: "",
    bestRunId: "",
    runIds: [],
    phase: "baseline",
    turns: [],
  });
  db.close();
  const restarted = await createApplication({
    dataDirectory: directory,
    runtime,
  });
  cleanups.push(() => restarted.close());
  const recovered = await restarted.execute<"research.launch">(
    "research.launch",
    input,
  );
  expect(recovered.session).toMatchObject({
    id: original.session.id,
    baselineRunId: original.session.baselineRunId,
    currentRunId: original.session.currentRunId,
    status: "halted",
  });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(researcher).toHaveBeenCalledTimes(priorResearcherCalls);
});
