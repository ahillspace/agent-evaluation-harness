import { targetFixture } from "../../tests/fixtures/runtime-targets.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import type { AgentConfig, RuntimePort, Json } from "../contracts.js";
import { createApplication } from "./application.js";
import { researchJevChoice } from "./research.js";
import { startServer } from "../server.js";
import type {
  CommandInput,
  CommandName,
  CommandResultMap,
} from "../contracts.js";

const agent: AgentConfig = {
  harness: "codex",
  model: "fixture",
  systemPrompt: "Baseline",
  settings: {},
  tools: [],
  connections: [],
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
it("keeps Jev research promotion gated on the overall review flag", () => {
  expect(
    researchJevChoice({
      status: "completed",
      reviewRequired: true,
      checks: { answer: { choice: "acceptable" } },
    }),
  ).toBeUndefined();
  expect(
    researchJevChoice({
      status: "completed",
      reviewRequired: false,
      checks: { answer: { choice: "incorrect" } },
    }),
  ).toBe("incorrect");
  expect(
    researchJevChoice({
      status: "completed",
      checks: { answer: { choice: "insufficient_evidence" } },
    }),
  ).toBeUndefined();
});
async function setup(
  execute: RuntimePort["execute"],
  researcher: RuntimePort["researcher"],
) {
  const directory = await mkdtemp(join(tmpdir(), "aeh-research-recovery-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
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
  const bank = await app.execute("banks.create", {
    name: "Fixture",
    questions: [
      { id: "q1", text: "First", expected: 42 },
      { id: "q2", text: "Second", expected: 42 },
    ],
  });
  return { app, bank, directory, runtime };
}

it("keeps interrupted researcher usage with its evaluated Run through candidate admission and reopen", async () => {
  const checkpoint = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const first = checkpoint();
  const candidate = checkpoint();
  const releaseCandidate = checkpoint();
  const reviewing = checkpoint();
  const releaseReview = checkpoint();
  let targets = 0;
  let researchers = 0;
  const f = await setup(
    async () => {
      if (++targets === 3) {
        candidate.resolve();
        await releaseCandidate.promise;
      }
      return { answer: 42, text: "42" };
    },
    async (input) => {
      researchers++;
      if (researchers === 1) {
        input.onEvent({
          type: "conversation.created",
          message: "Acknowledged fixture conversation",
          data: { conversationId: "exact-usage-conversation" },
        });
        await new Promise<void>((_, reject) => {
          input.signal.addEventListener(
            "abort",
            () => reject(new Error("Interrupted fixture researcher")),
            { once: true },
          );
          first.resolve();
        });
      }
      expect(input.conversationId).toBe("exact-usage-conversation");
      if (researchers === 2)
        return {
          conversationId: input.conversationId!,
          message: "Evaluate a distinct candidate",
          disposition: "keep",
          control: "continue",
          proposal: { ...agent, systemPrompt: "Candidate" },
          usageScope: "conversation",
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            cachedInputTokens: 10,
            costUsd: 0.01,
          },
        };
      reviewing.resolve();
      await releaseReview.promise;
      return {
        conversationId: input.conversationId!,
        message: "Keep candidate and finish",
        disposition: "keep",
        control: "stop",
        usageScope: "conversation",
        usage: {
          inputTokens: 160,
          outputTokens: 30,
          cachedInputTokens: 15,
          costUsd: 0.015,
        },
      };
    },
  );
  let server = await startServer({
    application: f.app,
    port: 0,
    host: "127.0.0.1",
  });
  cleanups.push(() => server.close());
  async function post<K extends CommandName>(
    operation: K,
    input: CommandInput<K>,
  ): Promise<CommandResultMap[K]> {
    const response = await fetch(`${server.url}/api/commands/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const body: unknown = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body as CommandResultMap[K];
  }
  const raw = (sessionId: string) => {
    const db = new DatabaseSync(join(f.directory, "workspace.sqlite"), {
      readOnly: true,
    });
    try {
      return db
        .prepare("SELECT value FROM records WHERE kind='research' AND id=?")
        .get(sessionId)!.value;
    } finally {
      db.close();
    }
  };
  try {
    const launch = await post("research.launch", {
      baseline: { bankRevisionId: f.bank.id, agent },
      researcher: agent,
      objective: "Accuracy",
      maxCandidates: 2,
      maxTargetInvocations: 6,
      maxResearcherTurns: 4,
    });
    const sessionId = launch.session.id;
    const baselineId = launch.session.baselineRunId;
    await first.promise;
    await post("research.control", { sessionId, action: "halt" });
    await f.app.waitForIdle();
    const interrupted = await post("runs.get", { runId: baselineId });
    expect(interrupted.performance!.researcher.reporting!.inputTokens).toEqual({
      reported: 0,
      missing: 1,
      pending: 0,
    });
    await post("research.control", { sessionId, action: "resume" });
    await candidate.promise;
    const evaluating = await post("research.get", { sessionId });
    const candidateId = evaluating.session.currentRunId;
    expect(candidateId).not.toBe(baselineId);
    const baseline = await post("runs.get", { runId: baselineId });
    const newCandidate = await post("runs.get", { runId: candidateId });
    expect(baseline.performance!.researcher.reporting!.inputTokens).toEqual({
      reported: 1,
      missing: 1,
      pending: 0,
    });
    expect(baseline.performance!.researcher.turns).toBeNull();
    expect(newCandidate.performance!.researcher).toMatchObject({
      inputTokens: 0,
      turns: 0,
      reporting: { inputTokens: { reported: 0, missing: 0, pending: 0 } },
    });
    expect(evaluating.session).toMatchObject({
      researcherInvocations: 2,
      interruptedTurns: 1,
    });
    releaseCandidate.resolve();
    await reviewing.promise;
    const pending = await post("runs.get", { runId: candidateId });
    expect(pending.performance!.researcher.reporting!.inputTokens).toEqual({
      reported: 0,
      missing: 0,
      pending: 1,
    });
    expect(pending.performance!.researcher.turns).toBe(1);
    releaseReview.resolve();
    await f.app.waitForIdle();
    const finished = await post("research.get", { sessionId });
    expect(finished.session).toMatchObject({
      status: "completed",
      researcherInvocations: 3,
      interruptedTurns: 1,
    });
    expect(finished.session.turns).toHaveLength(2);
    const comparison = await post("runs.compare", {
      runIds: [baselineId, candidateId],
    });
    expect(
      comparison.rows.map((row) => row.performance!.researcher.inputTokens),
    ).toEqual([100, 60]);
    expect(
      comparison.rows.map(
        (row) => row.performance!.researcher.reporting!.inputTokens.missing,
      ),
    ).toEqual([1, 0]);
    const settled = raw(sessionId);
    await server.close();
    const reopened = await createApplication({
      dataDirectory: f.directory,
      runtime: f.runtime,
    });
    cleanups.push(() => reopened.close());
    server = await startServer({
      application: reopened,
      port: 0,
      host: "127.0.0.1",
    });
    const saved = await post("runs.get", { runId: baselineId });
    expect(saved.performance!.researcher).toEqual(
      comparison.rows[0]!.performance!.researcher,
    );
    expect(raw(sessionId)).toBe(settled);
    expect(targets).toBe(4);
    expect(researchers).toBe(3);
  } finally {
    releaseCandidate.resolve();
    releaseReview.resolve();
  }
});

it("keeps an unprompted researcher failure terminal rather than resuming it", async () => {
  const f = await setup(
    async () => ({ answer: 42, text: "42" }),
    async (input) => {
      input.onEvent({
        type: "conversation.created",
        message: "Acknowledged",
        data: { conversationId: "failed-conversation" },
      });
      throw new Error("Unprompted provider failure");
    },
  );
  const launched = await f.app.execute("research.launch", {
    baseline: { bankRevisionId: f.bank.id, agent },
    researcher: agent,
    objective: "Accuracy",
  });
  await f.app.waitForIdle();
  const stopped = await f.app.execute("research.get", {
    sessionId: launched.session.id,
  });
  expect(stopped.session.status).toBe("failed");
  await expect(
    f.app.execute("research.control", {
      sessionId: launched.session.id,
      action: "resume",
    }),
  ).rejects.toThrow("Cannot resume a failed run.");
});
it("keeps an evaluated candidate independently of stopping research", async () => {
  let turns = 0;
  const { app, bank } = await setup(
    async () => ({ answer: 42, text: "42" }),
    async () =>
      ++turns === 1
        ? {
            conversationId: "fixture",
            message: "Try candidate",
            disposition: "keep",
            control: "continue",
            proposal: { ...agent, systemPrompt: "Candidate" },
          }
        : {
            conversationId: "fixture",
            message: "Keep it and stop",
            disposition: "keep",
            control: "stop",
          },
  );
  const started = await app.execute("research.launch", {
    baseline: { bankRevisionId: bank.id, agent },
    researcher: agent,
    objective: "Accuracy",
    maxCandidates: 1,
  });
  await app.waitForIdle();
  const { session } = await app.execute("research.get", {
    sessionId: started.session.id,
  });
  expect(session.runIds).toHaveLength(2);
  expect(session.bestRunId).toBe(session.runIds[1]);
  expect(session.status).toBe("completed");
});
it("refuses voluntary stopping when disabled without repeating an evaluated candidate", async () => {
  let turns = 0,
    calls = 0;
  const { app, bank } = await setup(
    async () => {
      calls++;
      return { answer: 42, text: "42" };
    },
    async () => {
      turns++;
      return turns === 1
        ? {
            conversationId: "fixture",
            message: "No improvement",
            disposition: "keep",
            control: "stop",
          }
        : turns === 2
          ? {
              conversationId: "fixture",
              message: "Try candidate",
              disposition: "keep",
              control: "continue",
              proposal: { ...agent, systemPrompt: "Candidate" },
            }
          : {
              conversationId: "fixture",
              message: "No improvement",
              disposition: "keep",
              control: "stop",
            };
    },
  );
  const started = await app.execute("research.launch", {
    baseline: { bankRevisionId: bank.id, agent },
    researcher: agent,
    objective: "Accuracy",
    allowResearcherStop: false,
    maxCandidates: 1,
    maxResearcherTurns: 4,
  });
  await app.waitForIdle();
  const { session } = await app.execute("research.get", {
    sessionId: started.session.id,
  });
  expect(session.runIds).toHaveLength(2);
  expect(calls).toBe(4);
  expect(session.stopReason).toContain("Candidate budget");
});
it("compares candidates with the same eligible denominator and reports coverage", async () => {
  const summaries: Json[] = [];
  const bestSummaries: Json[] = [];
  let turns = 0;
  const { app, bank } = await setup(
    async (input) => {
      if (
        input.target.kind === "managed" &&
        input.target.agent.systemPrompt === "Candidate" &&
        input.question.id === "q2"
      )
        throw Object.assign(new Error("fixture execution failure"), {
          code: "target_failure",
        });
      return { answer: input.question.id === "q1" ? 42 : 0, text: "fixture" };
    },
    async (input) => {
      const payload = JSON.parse(input.message) as Record<string, Json>;
      summaries.push(payload.baselineRun ?? payload.completedRun!);
      if (payload.bestRun) bestSummaries.push(payload.bestRun);
      if (turns === 0) {
        const baseline = await app.execute("runs.get", {
          runId: (payload.baselineRun as { runId: string }).runId,
        });
        const corrected = await app.execute("banks.revise", {
          bankId: bank.bankId,
          baseRevisionId: bank.id,
          baseEvaluatorRevisionId: baseline.run.manifest.evaluator.id,
          name: bank.name,
          questions: bank.questions.map((question) => ({
            ...question,
            expected: question.id === "q2" ? 0 : 42,
          })),
        });
        const later = await app.execute("runs.assess", {
          runId: baseline.run.id,
          source: "deterministic",
          name: "Later corrected-reference score",
          evaluatorRevisionId: baseline.run.manifest.evaluator.id,
          bankRevisionId: corrected.id,
        });
        expect(later.accuracy).toBe(1);
      }
      return ++turns === 1
        ? {
            conversationId: "fixture",
            message: "Try candidate",
            disposition: "keep",
            control: "continue",
            proposal: { ...agent, systemPrompt: "Candidate" },
          }
        : {
            conversationId: "fixture",
            message: "Keep candidate",
            disposition: "keep",
            control: "stop",
          };
    },
  );
  const started = await app.execute("research.launch", {
    baseline: { bankRevisionId: bank.id, agent },
    researcher: agent,
    objective: "Accuracy",
    maxCandidates: 1,
  });
  await app.waitForIdle();
  const { session } = await app.execute("research.get", {
    sessionId: started.session.id,
  });
  expect(summaries).toMatchObject([
    { accuracy: 0.5, eligibleOutcome: 0.5, eligible: 2, coverage: 1 },
    { accuracy: 1, eligibleOutcome: 0.5, eligible: 2, coverage: 0.5 },
  ]);
  expect(session.bestRunId).toBe(session.baselineRunId);
  expect(bestSummaries).toMatchObject([
    { accuracy: 0.5, eligibleOutcome: 0.5, eligible: 2, coverage: 1 },
  ]);
});
it("runs other questions while safe provider retry waits at concurrency one", async () => {
  const calls: string[] = [];
  const { app, bank } = await setup(
    async (input) => {
      calls.push(input.question.id);
      if (calls.length === 1)
        throw Object.assign(new Error("Capacity"), {
          executionFailure: {
            category: "provider-capacity",
            transient: true,
            retrySafety: "not-started",
          },
        });
      return { answer: 42, text: "42" };
    },
    async () => {
      throw new Error("Unused");
    },
  );
  await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
    limits: { concurrency: 1 },
  });
  await app.waitForIdle();
  expect(calls).toEqual(["q1", "q2", "q1"]);
});

it("stops subsequent admissions after a permanent provider authentication failure", async () => {
  let calls = 0;
  const { app, bank } = await setup(
    async () => {
      calls++;
      throw Object.assign(new Error("Provider rejected credentials"), {
        code: "target_failure",
        executionFailure: {
          category: "authentication",
          transient: false,
          retrySafety: "not-started",
        },
      });
    },
    async () => {
      throw new Error("Unused");
    },
  );
  const started = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
    limits: { concurrency: 1 },
  });
  await app.waitForIdle();
  const view = await app.execute("runs.get", { runId: started.run.id });
  expect(calls).toBe(1);
  expect(view.run.status).toBe("halted");
});
