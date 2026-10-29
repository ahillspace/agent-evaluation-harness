import { isDeepStrictEqual } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { agentSchema, judgeSchema, type RuntimePort } from "../contracts.js";
import { createApplication } from "./application.js";
import { Database } from "../storage/database.js";
import { buildJudgeEvidence } from "./judge-evidence.js";
import { targetFixture } from "../../tests/fixtures/runtime-targets.js";

const agent = agentSchema.parse({ harness: "codex", model: "fixture" });
const judge = judgeSchema.parse({
  enabled: true,
  agent,
  evidenceRequirement: "internal-activity",
});
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(
  execute: RuntimePort["execute"],
  judgeCall: RuntimePort["judge"],
) {
  const directory = await mkdtemp(join(tmpdir(), "aeh-llm-evidence-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const runtime: RuntimePort = {
    ...targetFixture,
    execute,
    judge: judgeCall,
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
      throw Error("unused");
    },
    testConnection: async () => ({ ok: true, message: "ok" }),
    researcher: async () => {
      throw Error("Researcher must not be admitted");
    },
  };
  const app = await createApplication({ dataDirectory: directory, runtime });
  cleanup.push(() => app.close());
  const bank = await app.execute("banks.create", {
    name: "Judge evidence",
    questions: [{ id: "q", text: "Count", expected: 42 }],
  });
  return { app, bank, directory };
}

it("does not admit an original LLM judge after the target consumes the research token budget", async () => {
  const call = vi
    .fn<RuntimePort["judge"]>()
    .mockResolvedValue({ verdict: true });
  const { app, bank } = await setup(
    async () => ({
      answer: 42,
      text: "42",
      usage: { inputTokens: 100, outputTokens: 0 },
    }),
    call,
  );
  const launched = await app.execute("research.launch", {
    baseline: { bankRevisionId: bank.id, agent, judge },
    researcher: agent,
    objective: "Improve",
    maxTotalTokens: 100,
  });
  await app.waitForIdle();
  const view = await app.execute("research.get", {
    sessionId: launched.session.id,
  });
  expect(call).not.toHaveBeenCalled();
  const run = await app.execute("runs.get", {
    runId: view.session.baselineRunId!,
  });
  expect(run.scoreSets[0]?.assessments[0]?.judgeError).toMatch(/Token budget/);
});

it("sends complete sealed activity through the same original and saved LLM judging contract", async () => {
  const transcript = [
    {
      type: "tool.result",
      text: "Recorded query result",
      payload: "x".repeat(90_000),
    },
  ];
  const call = vi
    .fn<RuntimePort["judge"]>()
    .mockResolvedValue({ verdict: true });
  const { app, bank } = await setup(
    async () => ({ answer: 42, text: "42", transcript }),
    call,
  );
  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
    judge,
  });
  await app.waitForIdle();
  await app.execute("runs.assess", {
    runId: launched.run.id,
    name: "Repeat",
    source: "llm",
    judge,
  });
  expect(call).toHaveBeenCalledTimes(2);
  for (const [input] of call.mock.calls) {
    expect(input.evidence?.trace.format).toBe("provider_transcript");
    expect(isDeepStrictEqual(input.evidence?.trace.entries, transcript)).toBe(
      true,
    );
    expect(JSON.stringify(input)).not.toContain("Original LLM judge");
  }
});

it("rejects a target that records answer-only evidence before original and saved activity judging", async () => {
  const call = vi
    .fn<RuntimePort["judge"]>()
    .mockResolvedValue({ verdict: true });
  const { app, bank } = await setup(
    async () => ({ answer: 42, text: "42", evidenceScope: "answer-only" }),
    call,
  );
  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
    judge,
  });
  await app.waitForIdle();
  const pass = await app.execute("runs.assess", {
    runId: launched.run.id,
    name: "Repeat",
    source: "llm",
    judge,
  });
  expect(call).not.toHaveBeenCalled();
  expect(pass.judgments[0]).toMatchObject({ status: "error" });
});

it("preserves known usage and malformed provider evidence in original and saved failed judgments", async () => {
  const invocation = {
    request: { prompt: "Judge the recorded answer" },
    response: {
      text: "not JSON",
      transcript: [{ type: "assistant", text: "not JSON" }],
    },
    configuration: judge,
    provenance: { harness: "codex", model: "fixture" },
    usage: { inputTokens: 17, outputTokens: 5 },
  };
  const call = vi
    .fn<RuntimePort["judge"]>()
    .mockRejectedValue(
      Object.assign(new Error("Invalid judge response"), { invocation }),
    );
  const { app, bank } = await setup(
    async () => ({ answer: 42, text: "42" }),
    call,
  );
  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
    judge,
  });
  await app.waitForIdle();
  const original = await app.execute("runs.get", { runId: launched.run.id });
  const pass = await app.execute("runs.assess", {
    runId: launched.run.id,
    name: "Malformed",
    source: "llm",
    judge,
  });
  const originalPass = original.assessmentPasses!.find(
    (p) => p.source === "llm",
  )!;
  const savedOriginal = await app.execute("runs.assessment", {
    runId: launched.run.id,
    passId: originalPass.id,
  });
  for (const judgment of [savedOriginal.judgments[0], pass.judgments[0]]) {
    expect(judgment).toMatchObject({
      status: "error",
      usage: invocation.usage,
    });
    expect(JSON.stringify(judgment?.response)).toContain("not JSON");
    expect(JSON.stringify(judgment?.response)).toContain("fixture");
  }
});

it("admits the original judge when known target usage remains below the research ceiling", async () => {
  const call = vi.fn<RuntimePort["judge"]>().mockResolvedValue({
    verdict: true,
    usage: { inputTokens: 90, outputTokens: 0 },
  });
  const { app, bank } = await setup(
    async () => ({
      answer: 42,
      text: "42",
      usage: { inputTokens: 10, outputTokens: 0 },
    }),
    call,
  );
  await app.execute("research.launch", {
    baseline: { bankRevisionId: bank.id, agent, judge },
    researcher: agent,
    objective: "Improve",
    maxTotalTokens: 100,
  });
  await app.waitForIdle();
  expect(call).toHaveBeenCalledTimes(1);
});

it("stops original judge admission when the target outlasts the research duration", async () => {
  const call = vi
    .fn<RuntimePort["judge"]>()
    .mockResolvedValue({ verdict: true });
  const dateNow = Date.now;
  const { app, bank } = await setup(async () => {
    vi.spyOn(Date, "now").mockImplementation(() => dateNow() + 2_000);
    return { answer: 42, text: "42" };
  }, call);
  try {
    await app.execute("research.launch", {
      baseline: { bankRevisionId: bank.id, agent, judge },
      researcher: agent,
      objective: "Improve",
      maxDurationMs: 1_000,
    });
    await app.waitForIdle();
    expect(call).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

it("drains recorded activity pages and excludes earlier assessments from saved judging", async () => {
  const call = vi
    .fn<RuntimePort["judge"]>()
    .mockResolvedValue({ verdict: true });
  const { app, bank, directory } = await setup(
    async () => ({ answer: 42, text: "42" }),
    call,
  );
  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
  });
  await app.waitForIdle();
  const view = await app.execute("runs.get", { runId: launched.run.id });
  const attemptId = view.results[0]!.completedAttemptId!;
  await app.close();
  const db = new Database(join(directory, "workspace.sqlite"));
  try {
    db.transaction(() => {
      for (let index = 0; index < 5_005; index++)
        db.append({
          runId: launched.run.id,
          attemptId,
          type: "tool.result",
          message: `Activity ${index}`,
        });
    });
    const original = buildJudgeEvidence(db, launched.run.id, attemptId).trace;
    db.append({
      runId: launched.run.id,
      attemptId,
      type: "judge.request",
      message: "Prior judge evidence",
    });
    db.append({
      runId: launched.run.id,
      attemptId,
      type: "assessment.completed",
      message: "Prior judgment",
    });
    const saved = buildJudgeEvidence(db, launched.run.id, attemptId).trace;
    expect(original.format).toBe("recorded_events");
    expect(isDeepStrictEqual(original, saved)).toBe(true);
    expect(JSON.stringify(saved.entries)).toContain("Activity 5004");
    expect(JSON.stringify(saved.entries)).not.toContain("Prior judge");
    expect(call).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});
