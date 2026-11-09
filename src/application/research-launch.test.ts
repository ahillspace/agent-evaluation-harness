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
  type CommandName,
  type CommandInput,
  type CommandResultMap,
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
  vi.useRealTimers();
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
  cleanups.push(() =>
    rm(directory, { recursive: true, force: true, maxRetries: 3 }),
  );
  const execute = vi.fn(async () => ({ answer: 42, text: "42" }));
  const researcher = vi.fn<RuntimePort["researcher"]>(async () => ({
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

async function httpCommands(
  app: Awaited<ReturnType<typeof createApplication>>,
) {
  const server = await startServer({
    application: app,
    port: 0,
    host: "127.0.0.1",
  });
  cleanups.push(() => server.close());
  return async function post<K extends CommandName>(
    operation: K,
    input: CommandInput<K>,
  ) {
    const response = await fetch(`${server.url}/api/commands/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return {
      status: response.status,
      body: (await response.json()) as CommandResultMap[K],
    };
  };
}

it.each(["pause", "cancel"] as const)(
  "rejects candidate admission after %s during resolution and retains the pending conversation",
  async (action) => {
    const f = await setup();
    const post = await httpCommands(f.app);
    const entered = deferred();
    const release = deferred();
    f.runtime.resolveTarget = async (target) => {
      if (
        target.kind === "managed" &&
        target.agent.systemPrompt === "Candidate"
      ) {
        entered.resolve();
        await release.promise;
      }
      return targetFixture.resolveTarget.call(f.runtime, target);
    };
    f.researcher.mockImplementationOnce(async () => ({
      conversationId: "fixture-conversation",
      message: "Try candidate",
      control: "continue",
      proposal: { ...agent, systemPrompt: "Candidate" },
    }));
    const launch = await post("research.launch", {
      ...f.input,
      maxTargetInvocations: 10,
    });
    await entered.promise;
    try {
      expect(
        (
          await post("research.control", {
            sessionId: launch.body.session.id,
            action,
          })
        ).status,
      ).toBe(200);
    } finally {
      release.resolve();
    }
    await f.app.waitForIdle();
    const stopped = await post("research.get", {
      sessionId: launch.body.session.id,
    });
    expect(stopped.body.session.status).toBe(
      action === "cancel" ? "cancelled" : "paused",
    );
    expect(stopped.body.session.runIds).toEqual([
      launch.body.session.baselineRunId,
    ]);
    const recorded = new Database(join(f.directory, "workspace.sqlite"));
    try {
      expect(
        recorded.require("research", stopped.body.session.id).pendingProposal
          ?.systemPrompt,
      ).toBe("Candidate");
    } finally {
      recorded.close();
    }
    expect(stopped.body.session.conversationId).toBe("fixture-conversation");
    expect(f.execute).toHaveBeenCalledTimes(1);
    if (action === "pause") {
      expect(
        (
          await post("research.control", {
            sessionId: stopped.body.session.id,
            action: "resume",
          })
        ).status,
      ).toBe(200);
      await f.app.waitForIdle();
      const resumed = await post("research.get", {
        sessionId: stopped.body.session.id,
      });
      expect(resumed.body.session.status).toBe("completed");
      expect(resumed.body.session.runIds).toHaveLength(2);
      expect(resumed.body.session.conversationId).toBe("fixture-conversation");
      expect(f.execute).toHaveBeenCalledTimes(2);
    }
  },
);

it.each(["pause", "cancel"] as const)(
  "rejects initial baseline admission after %s and preserves launch receipt identity",
  async (action) => {
    const f = await setup();
    const post = await httpCommands(f.app);
    const entered = deferred();
    const release = deferred();
    f.runtime.resolveTarget = async (target) => {
      entered.resolve();
      await release.promise;
      return targetFixture.resolveTarget.call(f.runtime, target);
    };
    const input = { ...f.input, maxTargetInvocations: 10 };
    const pending = post("research.launch", input);
    await entered.promise;
    const workspace = await post("workspace.get", {});
    const sessionId = workspace.body.researchSessions[0]!.id;
    try {
      expect(
        (await post("research.control", { sessionId, action })).status,
      ).toBe(200);
    } finally {
      release.resolve();
    }
    expect((await pending).status).toBeGreaterThanOrEqual(400);
    await f.app.waitForIdle();
    const stopped = await post("research.get", { sessionId });
    expect(stopped.body.session.status).toBe(
      action === "cancel" ? "cancelled" : "paused",
    );
    expect(stopped.body.session.runIds).toEqual([]);
    expect(f.execute).not.toHaveBeenCalled();
    await f.app.close();
    const restarted = await createApplication({
      dataDirectory: f.directory,
      runtime: f.runtime,
    });
    cleanups.push(() => restarted.close());
    const reopened = await httpCommands(restarted);
    expect(
      (await reopened("research.get", { sessionId })).body.session.status,
    ).toBe(action === "cancel" ? "cancelled" : "paused");
    if (action === "pause") {
      expect(
        (await reopened("research.control", { sessionId, action: "resume" }))
          .status,
      ).toBe(200);
      await restarted.waitForIdle();
      const receipt = await reopened("research.launch", input);
      expect(receipt.status).toBe(200);
      expect(receipt.body.session.id).toBe(sessionId);
      expect(receipt.body.session.runIds).toHaveLength(1);
      expect(f.execute).toHaveBeenCalledTimes(1);
    } else {
      expect(
        (await reopened("research.launch", input)).status,
      ).toBeGreaterThanOrEqual(400);
      expect(f.execute).not.toHaveBeenCalled();
    }
  },
);

it("keeps a newer initialization Resume when the earlier paused baseline preparation returns late", async () => {
  const f = await setup();
  const post = await httpCommands(f.app);
  const entered = deferred();
  const release = deferred();
  f.runtime.resolveTarget = async (target) => {
    entered.resolve();
    await release.promise;
    return targetFixture.resolveTarget.call(f.runtime, target);
  };
  const input = { ...f.input, maxTargetInvocations: 10 };
  const initial = post("research.launch", input);
  await entered.promise;
  const sessionId = (await post("workspace.get", {})).body.researchSessions[0]!
    .id;
  try {
    expect(
      (await post("research.control", { sessionId, action: "pause" })).status,
    ).toBe(200);
    expect(
      (await post("research.control", { sessionId, action: "resume" })).status,
    ).toBe(200);
  } finally {
    release.resolve();
  }
  expect((await initial).status).toBe(409);
  await f.app.waitForIdle();
  const receipt = await post("research.launch", input);
  expect(receipt.status).toBe(200);
  expect(receipt.body.session.id).toBe(sessionId);
  expect(receipt.body.session.status).toBe("completed");
  expect(receipt.body.session.runIds).toHaveLength(1);
  expect(f.execute).toHaveBeenCalledTimes(1);
});

async function pausedBaseline(repetitions = 2, failed = false) {
  const f = await setup();
  const entered = deferred();
  const release = deferred();
  f.execute.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    if (failed)
      throw Object.assign(new Error("Nonfatal target failure"), {
        code: "target_failure",
      });
    return { answer: 42, text: "42" };
  });
  const server = await startServer({
    application: f.app,
    port: 0,
    host: "127.0.0.1",
  });
  cleanups.push(() => server.close());
  async function post<K extends CommandName>(
    operation: K,
    input: CommandInput<K>,
  ) {
    const response = await fetch(`${server.url}/api/commands/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return {
      status: response.status,
      body: (await response.json()) as CommandResultMap[K],
    };
  }
  const launch = await post("research.launch", {
    ...f.input,
    maxTargetInvocations: 10,
    baseline: { ...f.input.baseline, repetitions },
  });
  expect(launch.status).toBe(200);
  await entered.promise;
  try {
    expect(
      (
        await post("research.control", {
          sessionId: launch.body.session.id,
          action: "pause",
        })
      ).status,
    ).toBe(200);
  } finally {
    release.resolve();
  }
  await f.app.waitForIdle();
  return {
    ...f,
    post,
    sessionId: launch.body.session.id,
    runId: launch.body.session.baselineRunId,
  };
}

it("resumes paused Research after its final answer drains without repeating the target or changing its score family", async () => {
  const f = await pausedBaseline(1);
  const before = await f.post("runs.get", { runId: f.runId });
  expect(before.body.run.status).toBe("completed");
  const original = await f.post("runs.export-assessment", {
    runId: f.runId,
    passId: `original_deterministic_${f.runId}`,
  });
  expect(
    (await f.post("research.get", { sessionId: f.sessionId })).body.session
      .status,
  ).toBe("paused");
  expect(
    (
      await f.post("research.control", {
        sessionId: f.sessionId,
        action: "resume",
      })
    ).status,
  ).toBe(200);
  await f.app.waitForIdle();
  const after = await f.post("runs.get", { runId: f.runId });
  expect(after.body.run.execution).toEqual(before.body.run.execution);
  expect(
    (
      await f.post("runs.export-assessment", {
        runId: f.runId,
        passId: original.body.id,
      })
    ).body,
  ).toEqual(original.body);
  expect(
    (await f.post("research.get", { sessionId: f.sessionId })).body.session
      .status,
  ).toBe("completed");
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(f.researcher).toHaveBeenCalledTimes(1);
});

it("resumes Research after its last nonfatal failed slot drains under Pause", async () => {
  const f = await pausedBaseline(1, true);
  const before = await f.post("runs.get", { runId: f.runId });
  expect(before.body.run.status).toBe("completed");
  expect(before.body.progress).toEqual({ completed: 0, failed: 1, total: 1 });
  const scope = before.body.run.execution;
  expect(
    (
      await f.post("research.control", {
        sessionId: f.sessionId,
        action: "resume",
      })
    ).status,
  ).toBe(200);
  await f.app.waitForIdle();
  expect(
    (await f.post("runs.get", { runId: f.runId })).body.run.execution,
  ).toEqual(scope);
  expect(
    (await f.post("research.get", { sessionId: f.sessionId })).body.session
      .status,
  ).toBe("completed");
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(f.researcher).toHaveBeenCalledTimes(1);
});

it("retains live paused research ownership instead of allowing a manual budget takeover", async () => {
  const f = await pausedBaseline(2, true);
  const before = await f.post("runs.get", { runId: f.runId });
  expect(before.body.controllingJob?.kind).toBe("research");
  expect(before.body.retryEligibility?.available).toBe(false);
  expect(
    (
      await f.post("runs.retry-failed", {
        runId: f.runId,
        acknowledgeDuplicateWork: true,
        idempotencyKey: "no-live-takeover",
      })
    ).status,
  ).toBe(409);
  expect(
    (await f.post("runs.control", { runId: f.runId, action: "resume" })).status,
  ).toBe(200);
  await f.app.waitForIdle();
  const after = await f.post("runs.get", { runId: f.runId });
  expect(after.body.run.execution?.id).toBe(before.body.run.execution!.id);
  expect(after.body.run.execution?.controller).toBe("research");
  expect(after.body.run.execution?.budgetResearchSessionId).toBe(f.sessionId);
});

it.each(["pause", "halt"] as const)(
  "rejects delayed Research Resume after an identical-record repeated %s",
  async (action) => {
    const f = await pausedBaseline();
    if (action === "halt") {
      const entered = deferred();
      f.runtime.execute = async (input) => {
        entered.resolve();
        await new Promise<void>((resolve) => {
          input.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
          if (input.signal.aborted) resolve();
        });
        throw Object.assign(new Error("Fixture interrupted"), {
          code: "interrupted",
        });
      };
      await f.post("research.control", {
        sessionId: f.sessionId,
        action: "resume",
      });
      await entered.promise;
      await f.post("research.control", {
        sessionId: f.sessionId,
        action: "halt",
      });
      await f.app.waitForIdle();
    }
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T18:00:00Z"));
    expect(
      (await f.post("research.control", { sessionId: f.sessionId, action }))
        .status,
    ).toBe(200);
    await f.app.waitForIdle();
    const db = new Database(join(f.directory, "workspace.sqlite"));
    try {
      const parent = db.require("research", f.sessionId);
      const child = db.require("run", f.runId);
      const entered = deferred();
      const release = deferred();
      f.runtime.resolveTarget = async (target) => {
        entered.resolve();
        await release.promise;
        return targetFixture.resolveTarget.call(f.runtime, target);
      };
      const pending = f.post("research.control", {
        sessionId: f.sessionId,
        action: "resume",
      });
      try {
        await entered.promise;
        expect(
          (await f.post("research.control", { sessionId: f.sessionId, action }))
            .status,
        ).toBe(200);
        expect(db.require("research", f.sessionId)).toEqual(parent);
        expect(db.require("run", f.runId)).toEqual(child);
      } finally {
        release.resolve();
      }
      expect((await pending).status).toBe(409);
      await f.app.waitForIdle();
      expect(f.execute).toHaveBeenCalledTimes(1);
      expect(f.researcher).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  },
);

it.each([1, 2])(
  "honors routed Run execution guards with %s baseline slots",
  async (repetitions) => {
    const f = await pausedBaseline(repetitions);
    const before = await f.post("research.get", { sessionId: f.sessionId });
    expect(
      (
        await f.post("runs.control", {
          runId: f.runId,
          action: "resume",
          expectedExecutionId: "wrong-execution",
          idempotencyKey: "wrong-execution",
        })
      ).status,
    ).toBe(409);
    expect(
      (await f.post("research.get", { sessionId: f.sessionId })).body,
    ).toEqual(before.body);
    expect(f.execute).toHaveBeenCalledTimes(1);
  },
);

it("commits one routed Resume receipt for concurrent calls and replays it after terminal ownership handoff", async () => {
  const f = await pausedBaseline();
  const entered = deferred();
  const release = deferred();
  let resolutions = 0;
  f.runtime.resolveTarget = async (target) => {
    if (++resolutions === 2) entered.resolve();
    await release.promise;
    return targetFixture.resolveTarget.call(f.runtime, target);
  };
  const input = {
    runId: f.runId,
    action: "resume" as const,
    idempotencyKey: "concurrent-routed",
    expectedExecutionId: f.runId,
  };
  const first = f.post("runs.control", input);
  const second = f.post("runs.control", input);
  try {
    await entered.promise;
  } finally {
    release.resolve();
  }
  expect((await first).status).toBe(200);
  expect((await second).status).toBe(200);
  await f.app.waitForIdle();
  const terminal = await f.post("research.get", { sessionId: f.sessionId });
  expect(terminal.body.session.status).toBe("completed");
  expect(f.execute).toHaveBeenCalledTimes(2);
  expect(f.researcher).toHaveBeenCalledTimes(1);
  expect(
    terminal.body.events.filter(
      (event) =>
        event.type === "research.control.requested" &&
        event.message === "resume requested.",
    ),
  ).toHaveLength(1);
  expect((await f.post("runs.control", input)).status).toBe(200);
  expect(
    (await f.post("research.get", { sessionId: f.sessionId })).body,
  ).toEqual(terminal.body);
  expect(resolutions).toBe(2);
});

it.each([false, true])(
  "acknowledges active candidate preparation without invalidating admission, frozenDate=%s",
  async (frozenDate) => {
    const f = await setup();
    const post = await httpCommands(f.app);
    if (frozenDate) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-09T18:00:00Z"));
    }
    const entered = deferred();
    const release = deferred();
    f.runtime.resolveTarget = async (target) => {
      if (
        target.kind === "managed" &&
        target.agent.systemPrompt === "Candidate"
      ) {
        entered.resolve();
        await release.promise;
      }
      return targetFixture.resolveTarget.call(f.runtime, target);
    };
    f.researcher.mockImplementationOnce(async () => ({
      conversationId: "fixture-conversation",
      message: "Try candidate",
      control: "continue",
      proposal: { ...agent, systemPrompt: "Candidate" },
    }));
    const launch = await post("research.launch", {
      ...f.input,
      maxTargetInvocations: 10,
    });
    await entered.promise;
    const db = new Database(join(f.directory, "workspace.sqlite"));
    try {
      const before = db.require("research", launch.body.session.id);
      expect(
        (
          await post("research.control", {
            sessionId: before.id,
            action: "resume",
          })
        ).status,
      ).toBe(200);
      expect(db.require("research", before.id)).toEqual(before);
    } finally {
      db.close();
      release.resolve();
    }
    await f.app.waitForIdle();
    const after = await post("research.get", {
      sessionId: launch.body.session.id,
    });
    expect(after.body.session.runIds).toHaveLength(2);
    expect(after.body.session.runIds[0]).toBe(
      launch.body.session.baselineRunId,
    );
    expect(after.body.session.status).toBe("completed");
    expect(f.execute).toHaveBeenCalledTimes(2);
  },
);

it.each([false, true])(
  "allows evidence audit reads during candidate readiness, includeGold=%s",
  async (includeGold) => {
    const f = await setup();
    const post = await httpCommands(f.app);
    const entered = deferred();
    const release = deferred();
    f.runtime.resolveTarget = async (target) => {
      if (
        target.kind === "managed" &&
        target.agent.systemPrompt === "Candidate"
      ) {
        entered.resolve();
        await release.promise;
      }
      return targetFixture.resolveTarget.call(f.runtime, target);
    };
    f.researcher.mockImplementationOnce(async () => ({
      conversationId: "fixture-conversation",
      message: "Try candidate",
      control: "continue",
      proposal: { ...agent, systemPrompt: "Candidate" },
    }));
    const launch = await post("research.launch", {
      ...f.input,
      maxTargetInvocations: 10,
    });
    await entered.promise;
    const sessionId = launch.body.session.id;
    const runId = launch.body.session.baselineRunId;
    const db = new Database(join(f.directory, "workspace.sqlite"));
    try {
      const parent = db.require("research", sessionId);
      const child = db.require("run", runId);
      expect(
        (await post("research.evidence", { sessionId, runId, includeGold }))
          .status,
      ).toBe(200);
      expect(db.require("research", sessionId)).toEqual(parent);
      expect(db.require("run", runId)).toEqual(child);
      expect(db.events({ sessionId }).at(-1)?.type).toBe(
        includeGold ? "research.gold.retrieved" : "research.evidence.retrieved",
      );
    } finally {
      db.close();
      release.resolve();
    }
    await f.app.waitForIdle();
    const after = await post("research.get", { sessionId });
    expect(after.body.session.status).toBe("completed");
    expect(after.body.session.runIds).toHaveLength(2);
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(f.researcher).toHaveBeenCalledTimes(2);
  },
);

it.each([
  { action: "resume", includeGold: false },
  { action: "resume", includeGold: true },
  { action: "retry", includeGold: false },
  { action: "retry", includeGold: true },
] as const)(
  "allows evidence audit reads during manual $action readiness, includeGold=$includeGold",
  async ({ action, includeGold }) => {
    const f = await setup();
    const post = await httpCommands(f.app);
    f.execute.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Fixture configuration stop"), {
        code: "configuration_error",
        executionFailure: {
          category: "configuration",
          transient: false,
          retrySafety: "unknown",
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        },
      });
    });
    const launch = await post("research.launch", {
      ...f.input,
      maxTargetInvocations: 10,
      baseline: { ...f.input.baseline, repetitions: 2 },
    });
    await f.app.waitForIdle();
    const sessionId = launch.body.session.id;
    const runId = launch.body.session.baselineRunId;
    expect(
      (await post("research.get", { sessionId })).body.session.status,
    ).toBe("failed");
    const before = (await post("runs.get", { runId })).body;
    expect(before.results.map((result) => result.status).sort()).toEqual([
      "failed",
      "pending",
    ]);
    const entered = deferred();
    const release = deferred();
    f.runtime.resolveTarget = async (target) => {
      entered.resolve();
      await release.promise;
      return targetFixture.resolveTarget.call(f.runtime, target);
    };
    const input = {
      runId,
      expectedExecutionId: before.run.execution?.id ?? runId,
      idempotencyKey: "audit-during-admission",
      acknowledgeDuplicateWork: true,
    };
    const pending =
      action === "resume"
        ? post("runs.control", { ...input, action: "resume" })
        : post("runs.retry-failed", input);
    await entered.promise;
    const db = new Database(join(f.directory, "workspace.sqlite"));
    const parent = db.require("research", sessionId);
    try {
      const child = db.require("run", runId);
      expect(
        (await post("research.evidence", { sessionId, runId, includeGold }))
          .status,
      ).toBe(200);
      expect(db.require("research", sessionId)).toEqual(parent);
      expect(db.require("run", runId)).toEqual(child);
      expect(db.events({ runId }).at(-1)?.type).toBe(
        includeGold ? "research.gold.retrieved" : "research.evidence.retrieved",
      );
    } finally {
      db.close();
      release.resolve();
    }
    expect((await pending).status).toBe(200);
    await f.app.waitForIdle();
    const after = (await post("runs.get", { runId })).body;
    expect(after.run.id).toBe(runId);
    expect(after.run.execution?.controller).toBe("run");
    expect(after.run.execution?.budgetResearchSessionId).toBeUndefined();
    expect(
      after.results.filter((result) => result.status === "completed"),
    ).toHaveLength(1);
    expect((await post("research.get", { sessionId })).body.session).toEqual(
      parent,
    );
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(f.researcher).not.toHaveBeenCalled();
  },
);

it("acknowledges resumed empty baseline preparation without invalidating admission", async () => {
  const f = await setup();
  const post = await httpCommands(f.app);
  const initialEntered = deferred();
  const initialRelease = deferred();
  f.runtime.resolveTarget = async (target) => {
    initialEntered.resolve();
    await initialRelease.promise;
    return targetFixture.resolveTarget.call(f.runtime, target);
  };
  const initial = post("research.launch", f.input);
  await initialEntered.promise;
  const sessionId = (await post("workspace.get", {})).body.researchSessions[0]!
    .id;
  expect(
    (await post("research.control", { sessionId, action: "pause" })).status,
  ).toBe(200);
  initialRelease.resolve();
  expect((await initial).status).toBe(400);
  await f.app.waitForIdle();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T18:00:00Z"));
  const entered = deferred();
  const release = deferred();
  f.runtime.resolveTarget = async (target) => {
    entered.resolve();
    await release.promise;
    return targetFixture.resolveTarget.call(f.runtime, target);
  };
  expect(
    (await post("research.control", { sessionId, action: "resume" })).status,
  ).toBe(200);
  await entered.promise;
  const db = new Database(join(f.directory, "workspace.sqlite"));
  try {
    const before = db.require("research", sessionId);
    expect(before.currentRunId).toBe("");
    expect(
      (await post("research.control", { sessionId, action: "resume" })).status,
    ).toBe(200);
    expect(db.require("research", sessionId)).toEqual(before);
  } finally {
    db.close();
    release.resolve();
  }
  await f.app.waitForIdle();
  const after = await post("research.get", { sessionId });
  expect(after.body.session.runIds).toHaveLength(1);
  expect(after.body.session.baselineRunId).toBe(
    after.body.session.currentRunId,
  );
  expect(after.body.session.status).toBe("completed");
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(f.researcher).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "acknowledges original baseline initialization without a parallel launch, keyed=%s",
  async (keyed) => {
    const f = await setup();
    const post = await httpCommands(f.app);
    const entered = deferred();
    const release = deferred();
    let resolutions = 0;
    f.runtime.resolveTarget = async (target) => {
      resolutions++;
      entered.resolve();
      await release.promise;
      return targetFixture.resolveTarget.call(f.runtime, target);
    };
    const initial = post("research.launch", {
      ...f.input,
      idempotencyKey: keyed ? f.input.idempotencyKey : undefined,
    });
    await entered.promise;
    const sessionId = (await post("workspace.get", {})).body
      .researchSessions[0]!.id;
    const before = await post("research.get", { sessionId });
    expect(before.body.session.currentRunId).toBe("");
    try {
      expect(
        (await post("research.control", { sessionId, action: "resume" }))
          .status,
      ).toBe(200);
      expect((await post("research.get", { sessionId })).body).toEqual(
        before.body,
      );
    } finally {
      release.resolve();
      await initial;
    }
    expect((await initial).status).toBe(200);
    await f.app.waitForIdle();
    const after = await post("research.get", { sessionId });
    expect(after.body.session.status).toBe("completed");
    expect(after.body.session.runIds).toHaveLength(1);
    expect(resolutions).toBe(1);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.researcher).toHaveBeenCalledTimes(1);
  },
);

it("saves and replays routed acknowledgment receipts while the researcher is active", async () => {
  const f = await setup();
  const post = await httpCommands(f.app);
  const entered = deferred();
  const release = deferred();
  f.researcher.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return {
      conversationId: "fixture-conversation",
      message: "Done",
      control: "stop",
    };
  });
  const initial = await post("research.launch", {
    ...f.input,
    maxTargetInvocations: 10,
  });
  await entered.promise;
  const sessionId = initial.body.session.id;
  const runId = initial.body.session.baselineRunId;
  const before = await post("research.get", { sessionId });
  const input = {
    runId,
    action: "resume" as const,
    idempotencyKey: "acknowledge-researcher",
    expectedExecutionId: runId,
  };
  try {
    expect(
      (
        await post("runs.control", {
          ...input,
          expectedExecutionId: "wrong-execution",
        })
      ).status,
    ).toBe(409);
    expect((await post("runs.control", input)).status).toBe(200);
    expect((await post("runs.control", input)).status).toBe(200);
    expect((await post("research.get", { sessionId })).body).toEqual(
      before.body,
    );
    expect(f.researcher).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
  }
  await f.app.waitForIdle();
  const terminal = await post("research.get", { sessionId });
  expect(terminal.body.session.status).toBe("completed");
  expect((await post("runs.control", input)).status).toBe(200);
  expect((await post("research.get", { sessionId })).body).toEqual(
    terminal.body,
  );
  expect(f.researcher).toHaveBeenCalledTimes(1);
  expect(f.execute).toHaveBeenCalledTimes(1);
});

it("does not let a repeated terminal Research Cancel stop an independent manual recovery", async () => {
  const f = await pausedBaseline(1, true);
  expect(
    (
      await f.post("research.control", {
        sessionId: f.sessionId,
        action: "cancel",
      })
    ).status,
  ).toBe(200);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T18:00:00Z"));
  const entered = deferred();
  const release = deferred();
  f.execute.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return { answer: 42, text: "42" };
  });
  expect(
    (
      await f.post("runs.retry-failed", {
        runId: f.runId,
        idempotencyKey: "after-parent-cancel",
        acknowledgeDuplicateWork: true,
        expectedExecutionId: f.runId,
      })
    ).status,
  ).toBe(200);
  await entered.promise;
  try {
    const before = await f.post("runs.get", { runId: f.runId });
    expect(before.body.run.execution?.controller).toBe("run");
    expect(
      (
        await f.post("research.control", {
          sessionId: f.sessionId,
          action: "cancel",
        })
      ).status,
    ).toBe(200);
    expect((await f.post("runs.get", { runId: f.runId })).body).toEqual(
      before.body,
    );
  } finally {
    release.resolve();
  }
  await f.app.waitForIdle();
  expect((await f.post("runs.get", { runId: f.runId })).body.run.status).toBe(
    "completed",
  );
});

it("guards the requested historical Run while controlling the actual current Research child", async () => {
  const f = await setup();
  const post = await httpCommands(f.app);
  const entered = deferred();
  const release = deferred();
  let targets = 0;
  f.execute.mockImplementation(async () => {
    if (++targets === 3) {
      entered.resolve();
      await release.promise;
    }
    return { answer: 42, text: "42" };
  });
  f.researcher.mockImplementationOnce(async () => ({
    conversationId: "fixture-conversation",
    message: "Try candidate",
    control: "continue",
    proposal: { ...agent, systemPrompt: "Candidate" },
  }));
  const launch = await post("research.launch", {
    ...f.input,
    maxTargetInvocations: 10,
    baseline: { ...f.input.baseline, repetitions: 2 },
  });
  await entered.promise;
  const runId = launch.body.session.baselineRunId;
  const original = (await post("runs.get", { runId })).body;
  try {
    expect(
      (
        await post("runs.control", {
          runId,
          action: "pause",
          expectedExecutionId: runId,
        })
      ).status,
    ).toBe(200);
  } finally {
    release.resolve();
  }
  await f.app.waitForIdle();
  const parent = (
    await post("research.get", { sessionId: launch.body.session.id })
  ).body.session;
  expect(parent.status).toBe("paused");
  expect(parent.currentRunId).not.toBe(runId);
  expect(
    (await post("runs.get", { runId: parent.currentRunId })).body.run.status,
  ).toBe("paused");
  const input = {
    runId,
    action: "resume" as const,
    idempotencyKey: "historical-control",
    expectedExecutionId: runId,
  };
  expect((await post("runs.control", input)).status).toBe(200);
  await f.app.waitForIdle();
  const current = (await post("runs.get", { runId: parent.currentRunId })).body;
  expect(current.run.status).toBe("completed");
  expect(current.run.execution?.id).toBe(parent.currentRunId);
  expect(current.run.execution?.budgetResearchSessionId).toBe(parent.id);
  const after = (await post("runs.get", { runId })).body;
  expect(after.run).toEqual(original.run);
  expect(after.results).toEqual(original.results);
  expect(after.attempts).toEqual(original.attempts);
  expect(f.execute).toHaveBeenCalledTimes(4);
  expect((await post("runs.control", input)).status).toBe(200);
  expect(f.execute).toHaveBeenCalledTimes(4);
});

it("replays a keyed Halt without aborting newer work in the same Research execution", async () => {
  const f = await pausedBaseline();
  let dispatches = 0;
  let aborts = 0;
  let entered = deferred();
  f.runtime.execute = async (input) => {
    dispatches++;
    entered.resolve();
    await new Promise<void>((resolve) => {
      const stop = () => {
        aborts++;
        resolve();
      };
      input.signal.addEventListener("abort", stop, { once: true });
      if (input.signal.aborted) stop();
    });
    throw Object.assign(new Error("Fixture interrupted"), {
      code: "interrupted",
    });
  };
  expect(
    (await f.post("runs.control", { runId: f.runId, action: "resume" })).status,
  ).toBe(200);
  await entered.promise;
  const halt = {
    runId: f.runId,
    action: "halt" as const,
    idempotencyKey: "keyed-halt",
    expectedExecutionId: f.runId,
  };
  expect((await f.post("runs.control", halt)).status).toBe(200);
  await f.app.waitForIdle();
  expect(aborts).toBe(1);
  entered = deferred();
  expect(
    (
      await f.post("runs.control", {
        runId: f.runId,
        action: "resume",
        acknowledgeDuplicateWork: true,
        idempotencyKey: "after-keyed-halt",
      })
    ).status,
  ).toBe(200);
  await entered.promise;
  try {
    expect((await f.post("runs.control", halt)).status).toBe(200);
    expect((await f.post("runs.get", { runId: f.runId })).body.run.intent).toBe(
      "run",
    );
    expect(aborts).toBe(1);
    expect(dispatches).toBe(2);
  } finally {
    await f.post("research.control", {
      sessionId: f.sessionId,
      action: "halt",
    });
    await f.app.waitForIdle();
  }
});

it("replays a routed Run Resume receipt after Halt without target or Research scheduling", async () => {
  const f = await pausedBaseline();
  const entered = deferred();
  let dispatches = 0;
  f.runtime.execute = async (input) => {
    dispatches++;
    entered.resolve();
    await new Promise<void>((resolve) => {
      input.signal.addEventListener("abort", () => resolve(), { once: true });
      if (input.signal.aborted) resolve();
    });
    throw Object.assign(new Error("Fixture interrupted"), {
      code: "interrupted",
    });
  };
  const input = {
    runId: f.runId,
    action: "resume" as const,
    acknowledgeDuplicateWork: true,
    idempotencyKey: "routed-replay",
    expectedExecutionId: f.runId,
  };
  expect((await f.post("runs.control", input)).status).toBe(200);
  await entered.promise;
  expect(
    (
      await f.post("research.control", {
        sessionId: f.sessionId,
        action: "halt",
      })
    ).status,
  ).toBe(200);
  await f.app.waitForIdle();
  const stopped = await f.post("research.get", { sessionId: f.sessionId });
  expect((await f.post("runs.control", input)).status).toBe(200);
  // A replay must not call either scheduler, even before a target can dispatch.
  expect(
    (await f.post("research.get", { sessionId: f.sessionId })).body,
  ).toEqual(stopped.body);
  expect(dispatches).toBe(1);
});

it("keeps a parent-only routed receipt valid after Research ownership ends and manual recovery starts", async () => {
  const f = await pausedBaseline(1, true);
  const input = {
    runId: f.runId,
    action: "resume" as const,
    idempotencyKey: "parent-only-replay",
    expectedExecutionId: f.runId,
  };
  expect((await f.post("runs.control", input)).status).toBe(200);
  await f.app.waitForIdle();
  const terminal = await f.post("research.get", { sessionId: f.sessionId });
  expect(terminal.body.session.status).toBe("completed");
  const recovered = await f.post("runs.retry-failed", {
    runId: f.runId,
    idempotencyKey: "manual-recovery",
    acknowledgeDuplicateWork: true,
    expectedExecutionId: f.runId,
  });
  expect(recovered.status).toBe(200);
  await f.app.waitForIdle();
  const before = await f.post("runs.get", { runId: f.runId });
  expect(before.body.run.execution?.id).not.toBe(f.runId);
  expect((await f.post("runs.control", input)).status).toBe(200);
  expect((await f.post("runs.get", { runId: f.runId })).body).toEqual(
    before.body,
  );
  expect(
    (await f.post("research.get", { sessionId: f.sessionId })).body,
  ).toEqual(terminal.body);
  expect(f.execute).toHaveBeenCalledTimes(2);
});

it("leaves paused parent and child unchanged when Research Resume readiness fails", async () => {
  const f = await pausedBaseline();
  const parent = await f.post("research.get", { sessionId: f.sessionId });
  const child = await f.post("runs.get", { runId: f.runId });
  f.runtime.resolveTarget = async () => {
    throw Object.assign(new Error("Frozen target unavailable"), {
      code: "configuration_error",
    });
  };
  const resumed = await f.post("research.control", {
    sessionId: f.sessionId,
    action: "resume",
  });
  expect(resumed.status).toBe(400);
  expect(
    (await f.post("research.get", { sessionId: f.sessionId })).body,
  ).toEqual(parent.body);
  expect((await f.post("runs.get", { runId: f.runId })).body).toEqual(
    child.body,
  );
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(f.researcher).not.toHaveBeenCalled();
});

it("lets competing Cancel win while Research Resume preflight waits without publishing a premature parent transition", async () => {
  const f = await pausedBaseline();
  const entered = deferred();
  const release = deferred();
  f.runtime.resolveTarget = async (target) => {
    entered.resolve();
    await release.promise;
    return targetFixture.resolveTarget.call(f.runtime, target);
  };
  const pending = f.post("research.control", {
    sessionId: f.sessionId,
    action: "resume",
  });
  try {
    await entered.promise;
    expect(
      (await f.post("research.get", { sessionId: f.sessionId })).body.session
        .status,
    ).toBe("paused");
    expect(
      (
        await f.post("research.control", {
          sessionId: f.sessionId,
          action: "cancel",
        })
      ).status,
    ).toBe(200);
  } finally {
    release.resolve();
  }
  expect((await pending).status).toBe(409);
  await f.app.waitForIdle();
  expect(
    (await f.post("research.get", { sessionId: f.sessionId })).body.session
      .status,
  ).toBe("cancelled");
  expect((await f.post("runs.get", { runId: f.runId })).body.run.status).toBe(
    "cancelled",
  );
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(f.researcher).not.toHaveBeenCalled();
});

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
