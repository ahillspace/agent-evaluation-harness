import { targetFixture } from "../../tests/fixtures/runtime-targets.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { AgentConfig, RuntimePort, Json } from "../contracts.js";
import { createApplication } from "./application.js";
import { researchJevChoice } from "./research.js";

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
  return { app, bank };
}
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
