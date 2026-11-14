import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { targetFixture } from "../../tests/fixtures/runtime-targets.js";
import type { ResearchRecord, RuntimePort } from "../contracts.js";
import { Database } from "../storage/database.js";
import { createApplication } from "./application.js";
import { startServer } from "../server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "aeh-research-startup-"));
  cleanups.push(() =>
    rm(path, { recursive: true, force: true, maxRetries: 3 }),
  );
  return path;
}
function read(path: string, sessionId: string) {
  const db = new DatabaseSync(join(path, "workspace.sqlite"), {
    readOnly: true,
  });
  try {
    return db
      .prepare("SELECT value FROM records WHERE kind='research' AND id=?")
      .get(sessionId)!.value as string;
  } finally {
    db.close();
  }
}
function change(
  path: string,
  sessionId: string,
  patch: Partial<ResearchRecord>,
) {
  const db = new Database(join(path, "workspace.sqlite"));
  try {
    const session = db.require("research", sessionId);
    db.update("research", { ...session, ...patch });
  } finally {
    db.close();
  }
}
async function fixture(maxTotalTokens?: number) {
  const path = await directory();
  const researcher = vi.fn<RuntimePort["researcher"]>(async () => ({
    conversationId: "exact-conversation",
    message: "Done",
    control: "stop",
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  const execute = vi.fn(async () => ({
    answer: 42,
    text: "42",
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected runtime call");
  };
  const runtime: RuntimePort = {
    ...targetFixture,
    researcher,
    execute,
    resolveAgent: async (agent) => agent,
    discover: async () => ({
      harnesses: [],
      connectionProviders: [],
      maxConcurrency: 1,
    }),
    recover: async () => ({ recovered: [], errors: [] }),
    close: async () => {},
    listConnections: async () => [],
    saveConnection: unused,
    deleteConnection: unused,
    testConnection: unused,
    judge: unused,
  };
  const open = async (dataDirectory = path) => {
    const app = await createApplication({ dataDirectory, runtime });
    cleanups.push(() => app.close());
    return app;
  };
  const app = await open();
  const bank = await app.execute("banks.create", {
    name: "Fixture",
    questions: [{ id: "q", text: "Count?", expected: 42 }],
  });
  const created = await app.execute("research.launch", {
    baseline: {
      bankRevisionId: bank.id,
      agent: { harness: "codex", model: "fixture" },
    },
    researcher: { harness: "codex", model: "fixture" },
    objective: "Accuracy",
    maxDurationMs: 86400000,
    maxTargetInvocations: 10,
    maxResearcherTurns: 10,
    ...(maxTotalTokens !== undefined ? { maxTotalTokens } : {}),
  });
  await app.waitForIdle();
  await app.close();
  change(path, created.session.id, {
    status: "halted",
    intent: "halt",
    phase: "evaluating",
  });
  researcher.mockClear();
  execute.mockClear();
  return {
    path,
    runtime,
    researcher,
    execute,
    open,
    sessionId: created.session.id,
    runId: created.session.currentRunId,
  };
}

it.each(["halted", "paused", "paused-empty"] as const)(
  "leaves settled %s research byte-identical through two opens, reads, and closes",
  async (state) => {
    const f = await fixture();
    if (state !== "halted")
      change(f.path, f.sessionId, {
        status: "paused",
        intent: "pause",
        ...(state === "paused-empty"
          ? {
              baselineRunId: "",
              currentRunId: "",
              bestRunId: "",
              runIds: [],
              phase: "baseline",
            }
          : {}),
      });
    if (state === "paused-empty") {
      const db = new DatabaseSync(join(f.path, "workspace.sqlite"));
      db.prepare("DELETE FROM idempotency WHERE key=?").run(
        `run:research:${f.sessionId}:baseline`,
      );
      db.close();
    }
    const before = read(f.path, f.sessionId);
    for (let cycle = 0; cycle < 2; cycle++) {
      const app = await f.open();
      expect(read(f.path, f.sessionId)).toBe(before);
      await app.execute("workspace.get", {});
      await app.execute("research.get", { sessionId: f.sessionId });
      expect(read(f.path, f.sessionId)).toBe(before);
      await app.close();
      expect(read(f.path, f.sessionId)).toBe(before);
    }
    expect(f.researcher).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  },
);

it("consumes caught admissions once, preserves request evidence, and counts a second real interruption", async () => {
  const f = await fixture();
  change(f.path, f.sessionId, { interruptedTurns: 7 });
  f.researcher.mockImplementation(async (input) => {
    expect(input.conversationId).toBe("exact-conversation");
    await new Promise<void>((resolve) => {
      input.signal.addEventListener("abort", () => resolve(), { once: true });
      if (input.signal.aborted) resolve();
    });
    throw new Error("Interrupted fixture researcher");
  });
  for (let admission = 1; admission <= 2; admission++) {
    const app = await f.open();
    await app.execute("research.control", {
      sessionId: f.sessionId,
      action: "resume",
    });
    await vi.waitFor(() =>
      expect(f.researcher).toHaveBeenCalledTimes(admission),
    );
    await app.execute("research.control", {
      sessionId: f.sessionId,
      action: "halt",
    });
    await app.waitForIdle();
    const saved = JSON.parse(read(f.path, f.sessionId)) as ResearchRecord;
    expect(saved).toMatchObject({
      status: "halted",
      interruptedTurns: 7,
      conversationId: "exact-conversation",
    });
    expect(saved.pendingTurn).toBeUndefined();
    expect(
      (await app.execute("research.get", { sessionId: f.sessionId })).session
        .interruptedTurns,
    ).toBe(admission);
    const usage = (await app.execute("runs.get", { runId: f.runId }))
      .performance!.researcher;
    expect(usage.reporting?.inputTokens).toMatchObject({
      missing: admission,
      pending: 0,
    });
    const db = new Database(join(f.path, "workspace.sqlite"));
    try {
      const requests = db
        .events({ sessionId: f.sessionId })
        .filter((event) => event.type === "research.turn.requested");
      expect(requests).toHaveLength(admission + 1);
      expect(requests.at(-1)!.data).toMatchObject({
        conversationId: "exact-conversation",
        input: expect.stringContaining("completedRun"),
      });
    } finally {
      db.close();
    }
    await app.close();
    const before = read(f.path, f.sessionId);
    for (let cycle = 0; cycle < 2; cycle++) {
      const reopened = await f.open();
      await reopened.close();
      expect(read(f.path, f.sessionId)).toBe(before);
    }
  }
  expect(f.execute).not.toHaveBeenCalled();
});

it.each([false, true])(
  "settles a crash snapshot of an admitted turn once, cancel=%s",
  async (cancel) => {
    const f = await fixture();
    change(f.path, f.sessionId, { interruptedTurns: 7 });
    let entered!: () => void;
    const admitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.researcher.mockImplementation(async (input) => {
      entered();
      await new Promise<void>((resolve) =>
        input.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw new Error("Interrupted fixture researcher");
    });
    const app = await f.open();
    await app.execute("research.control", {
      sessionId: f.sessionId,
      action: "resume",
    });
    await admitted;
    const crashed = await directory();
    const source = new DatabaseSync(join(f.path, "workspace.sqlite"), {
      readOnly: true,
    });
    try {
      await backup(source, join(crashed, "workspace.sqlite"));
    } finally {
      source.close();
    }
    await app.close();
    if (cancel)
      change(crashed, f.sessionId, {
        status: "cancelling",
        intent: "cancel",
        conversationId: undefined,
      });
    const first = await f.open(crashed);
    const saved = JSON.parse(read(crashed, f.sessionId)) as ResearchRecord;
    expect(saved).toMatchObject({
      status: cancel ? "cancelled" : "halted",
    });
    expect(saved.interruptedTurns).toBe(7);
    expect(
      (await first.execute("research.get", { sessionId: f.sessionId })).session
        .interruptedTurns,
    ).toBe(1);
    expect(saved.pendingTurn).toBeUndefined();
    const usage = (await first.execute("runs.get", { runId: f.runId }))
      .performance!.researcher;
    expect(usage.reporting?.inputTokens).toMatchObject({
      missing: 1,
      pending: 0,
    });
    await first.close();
    for (let cycle = 0; cycle < 2; cycle++) {
      const next = await f.open(crashed);
      await next.close();
      expect(read(crashed, f.sessionId)).toBe(JSON.stringify(saved));
    }
    expect(f.researcher).toHaveBeenCalledTimes(1);
  },
);

it("still rejects lost continuity in an already halted session", async () => {
  const f = await fixture();
  change(f.path, f.sessionId, {
    phase: "researching",
    conversationId: undefined,
  });
  const app = await f.open();
  const saved = await app.execute("research.get", { sessionId: f.sessionId });
  expect(saved.session).toMatchObject({
    status: "failed",
    intent: "halt",
    error: expect.stringContaining("conversation ID"),
  });
  expect(f.researcher).not.toHaveBeenCalled();
});

it.each(["cancelled", "failed", "completed"] as const)(
  "consumes a persisted %s checkpoint once and preserves input without a historical request event",
  async (status) => {
    const f = await fixture();
    const checkpoint = {
      input: `unique captured ${status} input`,
      startedAt: "2026-11-01T12:00:00.000Z",
    };
    change(f.path, f.sessionId, {
      status,
      intent:
        status === "cancelled"
          ? "cancel"
          : status === "failed"
            ? "halt"
            : "run",
      pendingTurn: checkpoint,
      interruptedTurns: 7,
      researcherInvocations: 9,
    });
    const app = await f.open();
    const saved = JSON.parse(read(f.path, f.sessionId)) as ResearchRecord;
    expect(saved.status).toBe(status);
    expect(saved.intent).toBe(
      status === "cancelled" ? "cancel" : status === "failed" ? "halt" : "run",
    );
    expect(saved.interruptedTurns).toBe(7);
    expect(
      (await app.execute("research.get", { sessionId: f.sessionId })).session
        .interruptedTurns,
    ).toBe(8);
    expect(saved.pendingTurn).toBeUndefined();
    const usage = (await app.execute("runs.get", { runId: f.runId }))
      .performance!.researcher;
    expect(usage.reporting?.inputTokens).toMatchObject({
      missing: 8,
      pending: 0,
    });
    const db = new Database(join(f.path, "workspace.sqlite"));
    try {
      const events = db.events({ sessionId: f.sessionId });
      expect(
        events
          .filter((event) => event.type === "research.turn.interrupted")
          .map((event) => event.data),
      ).toEqual([{ ...checkpoint, completion: "unknown" }]);
      expect(
        events.filter((event) => event.type === "research.turn.requested"),
      ).toHaveLength(1);
      expect(
        events
          .filter((event) => event.type === "research.turn.requested")
          .some((event) =>
            JSON.stringify(event.data).includes(checkpoint.input),
          ),
      ).toBe(false);
    } finally {
      db.close();
    }
    await app.close();
    const bytes = read(f.path, f.sessionId);
    const reopened = await f.open();
    await reopened.close();
    expect(read(f.path, f.sessionId)).toBe(bytes);
    const after = new Database(join(f.path, "workspace.sqlite"));
    try {
      expect(
        after
          .events({ sessionId: f.sessionId })
          .filter((event) => event.type === "research.turn.interrupted"),
      ).toHaveLength(1);
    } finally {
      after.close();
    }
    expect(f.researcher).not.toHaveBeenCalled();
  },
);

it("rolls back interrupted evidence and consumption together when saving its audit fails", async () => {
  const f = await fixture();
  change(f.path, f.sessionId, {
    researcherInvocations: 2,
    pendingTurn: {
      input: "unique unsaved request input",
      startedAt: "2026-11-01T12:00:00.000Z",
    },
  });
  const before = read(f.path, f.sessionId);
  const original = Database.prototype.append;
  const spy = vi
    .spyOn(Database.prototype, "append")
    .mockImplementation(function (this: Database, event) {
      if (event.type === "research.turn.interrupted") {
        original.call(this, event);
        throw new Error("Fixture audit write failed");
      }
      return original.call(this, event);
    });
  try {
    await expect(f.open()).rejects.toThrow("Fixture audit write failed");
  } finally {
    spy.mockRestore();
  }
  expect(read(f.path, f.sessionId)).toBe(before);
  const db = new Database(join(f.path, "workspace.sqlite"));
  try {
    expect(
      db
        .events({ sessionId: f.sessionId })
        .filter((event) => event.type === "research.turn.interrupted"),
    ).toEqual([]);
  } finally {
    db.close();
  }
  const recovered = await f.open();
  expect(
    (JSON.parse(read(f.path, f.sessionId)) as ResearchRecord).pendingTurn,
  ).toBeUndefined();
  await recovered.close();
});

it("preserves the recorded count of an already classified legacy failed checkpoint", async () => {
  const f = await fixture();
  const checkpoint = {
    input: "unique legacy failed admission input",
    startedAt: "2026-11-01T12:00:00.000Z",
  };
  change(f.path, f.sessionId, {
    status: "failed",
    intent: "run",
    phase: "researching",
    researcherInvocations: 2,
    interruptedTurns: 1,
    pendingTurn: checkpoint,
    error: "Fixture legacy provider failure",
  });
  const before = JSON.parse(read(f.path, f.sessionId)) as ResearchRecord;
  expect(before.turns).toHaveLength(1);
  const app = await f.open();
  const saved = JSON.parse(read(f.path, f.sessionId)) as ResearchRecord;
  expect(saved).toMatchObject({
    status: "failed",
    intent: "run",
    interruptedTurns: 1,
    researcherInvocations: 2,
  });
  expect(saved.pendingTurn).toBeUndefined();
  const usage = (await app.execute("runs.get", { runId: f.runId })).performance!
    .researcher;
  expect(usage.reporting?.inputTokens).toMatchObject({
    missing: 1,
    pending: 0,
  });
  await app.close();
  const bytes = read(f.path, f.sessionId);
  const restarted = await f.open();
  await restarted.close();
  expect(read(f.path, f.sessionId)).toBe(bytes);
  expect(f.researcher).not.toHaveBeenCalled();
});

it.each([0, 1])(
  "refuses a new admission with missing admission history and recorded interruptions %s",
  async (interruptedTurns) => {
    const f = await fixture();
    change(f.path, f.sessionId, {
      researcherInvocations: undefined,
      interruptedTurns,
    });
    const app = await f.open();
    expect(
      (await app.execute("research.get", { sessionId: f.sessionId })).session
        .interruptedTurns,
    ).toBe(interruptedTurns || undefined);
    await app.execute("research.control", {
      sessionId: f.sessionId,
      action: "resume",
    });
    await app.waitForIdle();
    expect(
      (await app.execute("research.get", { sessionId: f.sessionId })).session,
    ).toMatchObject({
      status: "failed",
      error: expect.stringContaining("admission history"),
    });
    const saved = JSON.parse(read(f.path, f.sessionId)) as ResearchRecord;
    expect(saved.researcherInvocations).toBeUndefined();
    expect(saved.interruptedTurns).toBe(interruptedTurns);
    expect(f.researcher).not.toHaveBeenCalled();
  },
);

it("refuses to reseed apparently empty admission history when durable turn evidence exists", async () => {
  const f = await fixture();
  change(f.path, f.sessionId, {
    researcherInvocations: undefined,
    interruptedTurns: undefined,
    turns: [],
    phase: "baseline",
  });
  const app = await f.open();
  await app.execute("research.control", {
    sessionId: f.sessionId,
    action: "resume",
  });
  await app.waitForIdle();
  expect(
    (await app.execute("research.get", { sessionId: f.sessionId })).session
      .error,
  ).toContain("admission history");
  expect(
    (JSON.parse(read(f.path, f.sessionId)) as ResearchRecord)
      .researcherInvocations,
  ).toBeUndefined();
  expect(f.researcher).not.toHaveBeenCalled();
});

it.each(
  [0, 1].flatMap((completed) =>
    [undefined, 0].map((recorded) => ({ completed, recorded })),
  ),
)(
  "keeps missing admission history unknown after consuming a checkpoint, T=$completed I=$recorded",
  async ({ completed, recorded }) => {
    const f = await fixture();
    const previous = JSON.parse(read(f.path, f.sessionId)) as ResearchRecord;
    change(f.path, f.sessionId, {
      researcherInvocations: undefined,
      turns: previous.turns.slice(0, completed),
      interruptedTurns: recorded,
      phase: "researching",
      pendingTurn: {
        input: "historical unknown researcher input",
        startedAt: previous.updatedAt,
      },
    });
    const app = await f.open();
    const session = (
      await app.execute("research.get", { sessionId: f.sessionId })
    ).session;
    expect(session.interruptedTurns).toBeUndefined();
    const performance = (await app.execute("runs.get", { runId: f.runId }))
      .performance!.researcher;
    expect(performance.turns).toBeNull();
    expect(performance.reporting?.inputTokens.missing).toBeGreaterThanOrEqual(
      1,
    );
    expect(performance.reporting?.inputTokens.pending).toBe(0);
    if (!completed) expect(performance.inputTokens).toBeNull();
    const raw = JSON.parse(read(f.path, f.sessionId)) as ResearchRecord;
    expect(raw.researcherInvocations).toBeUndefined();
    expect(raw.interruptedTurns).toBe(recorded);
    expect(raw.pendingTurn).toBeUndefined();
    await app.close();
    const bytes = read(f.path, f.sessionId);
    const db = new Database(join(f.path, "workspace.sqlite"));
    const events = db.events({ sessionId: f.sessionId });
    db.close();
    const next = await f.open();
    await next.close();
    expect(read(f.path, f.sessionId)).toBe(bytes);
    const after = new Database(join(f.path, "workspace.sqlite"));
    try {
      expect(after.events({ sessionId: f.sessionId })).toEqual(events);
    } finally {
      after.close();
    }
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.researcher).not.toHaveBeenCalled();
  },
);

it.each(
  [false, true].flatMap((bounded) =>
    [0, 1].flatMap((completed) =>
      [undefined, 0].map((recorded) => ({ bounded, completed, recorded })),
    ),
  ),
)(
  "blocks every candidate admission with unavailable history, bounded=$bounded T=$completed I=$recorded",
  async ({ bounded, completed, recorded }) => {
    const f = await fixture(bounded ? 100000 : undefined);
    const previous = JSON.parse(read(f.path, f.sessionId)) as ResearchRecord;
    const target = previous.configuration.baseline.target;
    if (target.kind !== "managed") throw new Error("Expected managed fixture");
    change(f.path, f.sessionId, {
      researcherInvocations: undefined,
      interruptedTurns: recorded,
      turns: previous.turns.slice(0, completed),
      phase: "researching",
      pendingTurn: {
        input: "unknown historical candidate checkpoint",
        startedAt: previous.updatedAt,
      },
      pendingProposal: {
        ...target.agent,
        systemPrompt: "Distinct valid candidate",
      },
    });
    const app = await f.open();
    await app.execute("research.control", {
      sessionId: f.sessionId,
      action: "resume",
    });
    await app.waitForIdle();
    const current = JSON.parse(read(f.path, f.sessionId)) as ResearchRecord;
    expect(current.runIds).toEqual(previous.runIds);
    expect(current.pendingProposal).toEqual({
      ...target.agent,
      systemPrompt: "Distinct valid candidate",
    });
    expect(current.researcherInvocations).toBeUndefined();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.researcher).not.toHaveBeenCalled();
    const db = new Database(join(f.path, "workspace.sqlite"));
    try {
      expect(db.list("run")).toHaveLength(1);
      expect(
        db
          .events({ sessionId: f.sessionId })
          .filter((event) => event.type === "research.turn.requested"),
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  },
);

it.each([
  { fact: "pristine baseline", history: false },
  { fact: "finished alone", history: false },
  { fact: "acknowledged conversation", history: true },
  { fact: "saved proposal", history: true },
  { fact: "researching phase", history: true },
  { fact: "evaluating phase", history: true },
  { fact: "candidate linkage", history: true },
])(
  "uses positive post-admission facts for $fact",
  async ({ fact, history }) => {
    const f = await fixture();
    const previous = JSON.parse(read(f.path, f.sessionId)) as ResearchRecord;
    const target = previous.configuration.baseline.target;
    if (target.kind !== "managed") throw new Error("Expected managed fixture");
    change(f.path, f.sessionId, {
      researcherInvocations: undefined,
      turns: [],
      pendingTurn: undefined,
      interruptedTurns: 0,
      conversationId:
        fact === "acknowledged conversation"
          ? "acknowledged-existing-conversation"
          : undefined,
      pendingProposal:
        fact === "saved proposal"
          ? { ...target.agent, systemPrompt: "Distinct valid proposal" }
          : undefined,
      phase:
        fact === "finished alone"
          ? "finished"
          : fact === "researching phase"
            ? "researching"
            : fact === "evaluating phase"
              ? "evaluating"
              : "baseline",
      runIds:
        fact === "candidate linkage"
          ? [f.runId, "recorded-candidate"]
          : [f.runId],
    });
    const sql = new DatabaseSync(join(f.path, "workspace.sqlite"));
    sql
      .prepare(
        "DELETE FROM events WHERE session_id=? AND type IN ('research.turn.started','research.turn.requested','research.turn.interrupted','conversation.created','research.decision','research.recovery','research.continuation.required')",
      )
      .run(f.sessionId);
    sql.close();
    const db = new Database(join(f.path, "workspace.sqlite"));
    try {
      expect(db.researchAccounting(f.sessionId)).toEqual(
        history
          ? { status: "unavailable", interrupted: undefined }
          : { status: "known", interrupted: 0, nextInvocation: 1 },
      );
    } finally {
      db.close();
    }
  },
);

it.each(
  [false, true].flatMap((proposal) =>
    [false, true].flatMap((bounded) =>
      [undefined, 0].map((recorded) => ({ proposal, bounded, recorded })),
    ),
  ),
)(
  "acknowledged conversation blocks HTTP admission, proposal=$proposal bounded=$bounded I=$recorded",
  async ({ proposal, bounded, recorded }) => {
    const f = await fixture(bounded ? 100000 : undefined);
    const previous = JSON.parse(read(f.path, f.sessionId)) as ResearchRecord;
    const target = previous.configuration.baseline.target;
    if (target.kind !== "managed") throw new Error("Expected managed fixture");
    change(f.path, f.sessionId, {
      researcherInvocations: undefined,
      turns: [],
      pendingTurn: undefined,
      interruptedTurns: recorded,
      phase: "baseline",
      pendingProposal: proposal
        ? { ...target.agent, systemPrompt: "Distinct valid candidate" }
        : undefined,
    });
    const sql = new DatabaseSync(join(f.path, "workspace.sqlite"));
    sql
      .prepare(
        "DELETE FROM events WHERE session_id=? AND type IN ('research.turn.started','research.turn.requested','research.turn.interrupted','conversation.created','research.decision','research.recovery','research.continuation.required')",
      )
      .run(f.sessionId);
    sql.close();
    const readiness = vi.spyOn(f.runtime, "resolveTarget");
    const app = await f.open();
    const server = await startServer({
      application: app,
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(() => server.close());
    const post = async (operation: string, input: object) => {
      const response = await fetch(`${server.url}/api/commands/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      expect(response.ok).toBe(true);
      return response.json();
    };
    const observed = await post("research.get", { sessionId: f.sessionId });
    expect(observed.session.interruptedTurns).toBeUndefined();
    const run = await post("runs.get", { runId: f.runId });
    expect(run.performance.researcher.turns).toBeNull();
    expect(run.performance.researcher.reporting.inputTokens).toMatchObject({
      missing: 1,
      pending: 0,
    });
    await post("research.control", {
      sessionId: f.sessionId,
      action: "resume",
    });
    await app.waitForIdle();
    const saved = JSON.parse(read(f.path, f.sessionId)) as ResearchRecord;
    expect(saved.runIds).toEqual(previous.runIds);
    expect(saved.researcherInvocations).toBeUndefined();
    expect(saved.interruptedTurns).toBe(recorded);
    expect(saved.conversationId).toBe(previous.conversationId);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.researcher).not.toHaveBeenCalled();
    expect(readiness).not.toHaveBeenCalled();
    const db = new Database(join(f.path, "workspace.sqlite"));
    try {
      expect(db.list("run")).toHaveLength(1);
    } finally {
      db.close();
    }
    await server.close();
    readiness.mockRestore();
  },
);

it.each([
  ...[
    "conversation.created",
    "research.decision",
    "research.recovery",
    "research.continuation.required",
    "research.turn.started",
    "research.turn.requested",
    "research.turn.interrupted",
    "usage",
    "message",
    "tool.started",
    "tool.completed",
    "error",
    "provider.future.event",
  ].map((type) => ({ type, history: true })),
  ...[
    "research.control.requested",
    "research.evidence.retrieved",
    "research.gold.retrieved",
    "research.completed",
    "research.error",
    "research.paused",
    "research.halted",
    "research.cancelled",
  ].map((type) => ({ type, history: false })),
])(
  "classifies retained $type evidence before any new admission",
  async ({ type, history }) => {
    const f = await fixture();
    change(f.path, f.sessionId, {
      researcherInvocations: undefined,
      turns: [],
      pendingTurn: undefined,
      interruptedTurns: undefined,
      conversationId: undefined,
      pendingProposal: undefined,
      phase: "baseline",
      runIds: [f.runId],
    });
    const sql = new DatabaseSync(join(f.path, "workspace.sqlite"));
    sql.prepare("DELETE FROM events WHERE session_id=?").run(f.sessionId);
    sql.close();
    const db = new Database(join(f.path, "workspace.sqlite"));
    try {
      db.append({
        sessionId: f.sessionId,
        type,
        message: "Synthetic retained lifecycle evidence",
      });
      expect(db.researchAccounting(f.sessionId)).toEqual(
        history
          ? { status: "unavailable", interrupted: undefined }
          : { status: "known", interrupted: 0, nextInvocation: 1 },
      );
    } finally {
      db.close();
    }
    const readiness = vi.spyOn(f.runtime, "resolveTarget");
    const app = await f.open();
    if (history) {
      const usage = (await app.execute("runs.get", { runId: f.runId }))
        .performance!.researcher;
      expect(usage.turns).toBeNull();
      expect(usage.reporting?.inputTokens.missing).toBeGreaterThanOrEqual(1);
    }
    await app.execute("research.control", {
      sessionId: f.sessionId,
      action: "resume",
    });
    await app.waitForIdle();
    expect(f.execute).not.toHaveBeenCalled();
    expect(readiness).not.toHaveBeenCalled();
    expect(f.researcher).toHaveBeenCalledTimes(history ? 0 : 1);
    const saved = JSON.parse(read(f.path, f.sessionId)) as ResearchRecord;
    expect(saved.researcherInvocations).toBe(history ? undefined : 1);
    expect(saved.runIds).toEqual([f.runId]);
    readiness.mockRestore();
  },
);

it("retains strict unknown-usage spending guards after consuming an interrupted turn", async () => {
  const f = await fixture(100);
  f.researcher.mockImplementation(async (input) => {
    await new Promise<void>((resolve) =>
      input.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    throw new Error("Interrupted fixture researcher");
  });
  const app = await f.open();
  await app.execute("research.control", {
    sessionId: f.sessionId,
    action: "resume",
  });
  await vi.waitFor(() => expect(f.researcher).toHaveBeenCalledTimes(1));
  await app.execute("research.control", {
    sessionId: f.sessionId,
    action: "halt",
  });
  await app.waitForIdle();
  await app.execute("research.control", {
    sessionId: f.sessionId,
    action: "resume",
  });
  await app.waitForIdle();
  const stopped = await app.execute("research.get", { sessionId: f.sessionId });
  expect(stopped.session.stopReason).toContain("interrupted researcher turn");
  expect(stopped.session.interruptedTurns).toBe(1);
  expect(f.researcher).toHaveBeenCalledTimes(1);
});

it("rejects inconsistent known admissions before startup consumes the checkpoint", async () => {
  const f = await fixture();
  const previous = JSON.parse(read(f.path, f.sessionId)) as ResearchRecord;
  expect(previous.researcherInvocations).toBe(1);
  expect(previous.turns).toHaveLength(1);
  change(f.path, f.sessionId, {
    pendingTurn: {
      input: "preserve invalid historical checkpoint input",
      startedAt: previous.updatedAt,
    },
  });
  const before = read(f.path, f.sessionId);
  const db = new Database(join(f.path, "workspace.sqlite"));
  const events = db.events({ sessionId: f.sessionId });
  db.close();
  await expect(f.open()).rejects.toThrow("admission history is inconsistent");
  expect(read(f.path, f.sessionId)).toBe(before);
  const after = new Database(join(f.path, "workspace.sqlite"));
  try {
    expect(after.events({ sessionId: f.sessionId })).toEqual(events);
  } finally {
    after.close();
  }
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.researcher).not.toHaveBeenCalled();
});

it("rejects boolean admission counts consistently in bounded database consumers", async () => {
  const f = await fixture();
  const sql = new DatabaseSync(join(f.path, "workspace.sqlite"));
  sql
    .prepare(
      "UPDATE records SET value=json_set(value,'$.researcherInvocations',json('true')) WHERE kind='research' AND id=?",
    )
    .run(f.sessionId);
  sql.close();
  const db = new Database(join(f.path, "workspace.sqlite"));
  try {
    expect(() => db.researchAccounting(f.sessionId)).toThrow(
      "admission history is inconsistent",
    );
    expect(() => db.researchSummary(f.sessionId)).toThrow(
      "admission history is inconsistent",
    );
    expect(() => db.researchUsage(f.sessionId)).toThrow(
      "admission history is inconsistent",
    );
  } finally {
    db.close();
  }
});

it.each(["usage", "message", "tool.started", "error", "provider.future.event"])(
  "ignores baseline Run and attempt scoped %s as researcher history",
  async (type) => {
    const f = await fixture();
    change(f.path, f.sessionId, {
      researcherInvocations: undefined,
      turns: [],
      pendingTurn: undefined,
      interruptedTurns: undefined,
      conversationId: undefined,
      pendingProposal: undefined,
      phase: "baseline",
      runIds: [f.runId],
    });
    const sql = new DatabaseSync(join(f.path, "workspace.sqlite"));
    sql.prepare("DELETE FROM events WHERE session_id=?").run(f.sessionId);
    sql.close();
    const db = new Database(join(f.path, "workspace.sqlite"));
    try {
      db.append({
        sessionId: f.sessionId,
        runId: f.runId,
        type,
        message: "Synthetic baseline activity",
      });
      db.append({
        sessionId: f.sessionId,
        attemptId: "baseline-attempt",
        type,
        message: "Synthetic attempt activity",
      });
      expect(db.researchAccounting(f.sessionId)).toEqual({
        status: "known",
        interrupted: 0,
        nextInvocation: 1,
      });
    } finally {
      db.close();
    }
    const app = await f.open();
    await app.execute("research.control", {
      sessionId: f.sessionId,
      action: "resume",
    });
    await app.waitForIdle();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.researcher).toHaveBeenCalledTimes(1);
  },
);

async function evaluatedCandidateFixture() {
  const f = await fixture();
  const previous = JSON.parse(read(f.path, f.sessionId)) as ResearchRecord;
  const target = previous.configuration.baseline.target;
  if (target.kind !== "managed") throw new Error("Expected managed fixture");
  f.researcher.mockImplementationOnce(async () => ({
    conversationId: "exact-conversation",
    message: "Evaluate a candidate",
    disposition: "keep",
    control: "continue",
    proposal: { ...target.agent, systemPrompt: "Distinct valid candidate" },
  }));
  f.researcher.mockImplementationOnce(async () => ({
    conversationId: "exact-conversation",
    message: "Retain evaluated candidate",
    disposition: "keep",
    control: "stop",
  }));
  const app = await f.open();
  await app.execute("research.control", {
    sessionId: f.sessionId,
    action: "resume",
  });
  await app.waitForIdle();
  await app.close();
  const saved = JSON.parse(read(f.path, f.sessionId)) as ResearchRecord;
  expect(saved.runIds).toHaveLength(2);
  expect(saved.currentRunId).toBe(saved.runIds[1]);
  expect(saved.bestRunId).toBe(saved.runIds[1]);
  f.execute.mockClear();
  f.researcher.mockClear();
  return { ...f, saved };
}

it.each([false, true])(
  "reconnects only a missing baseline without replacing established candidate links, known=%s",
  async (known) => {
    const f = await evaluatedCandidateFixture();
    change(f.path, f.sessionId, {
      baselineRunId: "",
      status: "halted",
      intent: "halt",
      ...(known
        ? {}
        : {
            researcherInvocations: undefined,
            turns: [],
            interruptedTurns: 0,
            conversationId: undefined,
            pendingProposal: undefined,
            phase: "baseline",
          }),
    });
    if (!known) {
      const sql = new DatabaseSync(join(f.path, "workspace.sqlite"));
      sql.prepare("DELETE FROM events WHERE session_id=?").run(f.sessionId);
      sql.close();
    }
    const before = JSON.parse(read(f.path, f.sessionId)) as ResearchRecord;
    const db = new Database(join(f.path, "workspace.sqlite"));
    const runs = db.list("run");
    const events = db.events({ sessionId: f.sessionId });
    db.close();
    const app = await f.open();
    const recovered = JSON.parse(read(f.path, f.sessionId)) as ResearchRecord;
    expect(recovered).toEqual({
      ...before,
      baselineRunId: f.saved.baselineRunId,
      updatedAt: recovered.updatedAt,
    });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.researcher).not.toHaveBeenCalled();
    const after = new Database(join(f.path, "workspace.sqlite"));
    try {
      expect(after.list("run")).toEqual(runs);
      expect(after.events({ sessionId: f.sessionId })).toEqual(events);
    } finally {
      after.close();
    }
    await app.execute("research.control", {
      sessionId: f.sessionId,
      action: "resume",
    });
    await app.waitForIdle();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.researcher).toHaveBeenCalledTimes(known ? 1 : 0);
    if (known)
      expect(
        JSON.parse(f.researcher.mock.calls[0]![0].message).completedRun.runId,
      ).toBe(f.saved.currentRunId);
    const final = JSON.parse(read(f.path, f.sessionId)) as ResearchRecord;
    expect(final.currentRunId).toBe(f.saved.currentRunId);
    expect(final.bestRunId).toBe(f.saved.bestRunId);
    expect(final.runIds).toEqual(f.saved.runIds);
  },
);

it.each(["missing selection", "foreign owner", "missing history"])(
  "rejects ambiguous baseline reconstruction before rewriting links: %s",
  async (kind) => {
    const f = await evaluatedCandidateFixture();
    let foreign: string | undefined;
    if (kind === "foreign owner") {
      const app = await f.open();
      const launched = await app.execute("research.launch", {
        ...f.saved.configuration,
        name: "Foreign fixture owner",
      });
      await app.waitForIdle();
      foreign = launched.session.currentRunId;
      await app.close();
    }
    change(f.path, f.sessionId, {
      baselineRunId: "",
      status: "halted",
      intent: "halt",
      ...(kind === "missing history"
        ? { currentRunId: "", bestRunId: "", runIds: [] }
        : foreign
          ? {
              currentRunId: foreign,
              bestRunId: foreign,
              runIds: [f.saved.baselineRunId, foreign],
            }
          : { bestRunId: "" }),
    });
    const before = read(f.path, f.sessionId);
    f.execute.mockClear();
    f.researcher.mockClear();
    await expect(f.open()).rejects.toThrow("links are inconsistent");
    expect(read(f.path, f.sessionId)).toBe(before);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.researcher).not.toHaveBeenCalled();
  },
);
