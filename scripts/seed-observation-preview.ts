import { resolve } from "node:path";
import { createApplication } from "../src/application/application.js";
import {
  agentSchema,
  jsonSchema,
  jevProfileSettingsSchema,
  type RuntimePort,
} from "../src/contracts.js";
import { targetFixture } from "../tests/fixtures/runtime-targets.js";

// Deliberately isolated, deterministic provider fixtures. No network or model calls.
const directory = resolve(".aeh/redesign-preview");
const agent = agentSchema.parse({
  harness: "codex",
  model: "fixture-target",
  systemPrompt: "Baseline fixture",
});
let turn = 0;
const runtime: RuntimePort = {
  ...targetFixture,
  resolveAgent: async (value) => value,
  recover: async () => ({ recovered: [], errors: [] }),
  close: async () => {},
  discover: async () => ({
    harnesses: [],
    connectionProviders: [],
    maxConcurrency: 2,
  }),
  listConnections: async () => [],
  saveConnection: async () => {
    throw Error("Fixture only");
  },
  deleteConnection: async () => {},
  testConnection: async () => ({ ok: true, message: "Fixture" }),
  execute: async (input) => {
    input.onEvent({
      type: "tool.started",
      message: "Fixture query",
      data: { name: "query", arguments: { question: input.question.id } },
    });
    input.onEvent({
      type: "tool.completed",
      message: "Fixture query completed",
      data: { name: "query", result: { value: 42 } },
    });
    if (
      input.question.id === "q3" &&
      input.target.kind === "managed" &&
      input.target.agent.systemPrompt.includes("Candidate")
    )
      throw Error(
        "Fixture transport failure after query. Side effects are unknown.",
      );
    const answer = input.question.id === "q2" ? 41 : 42;
    input.onEvent({ type: "usage", message: "Provider turn completed." });
    return {
      answer,
      text: String(answer),
      transcript: [{ role: "assistant", text: "Fixture answer" }],
      usage: { inputTokens: 120, outputTokens: 20, costUsd: 0 },
    };
  },
  judge: async (input) => ({
    verdict: input.question.id !== "q2",
    explanation:
      input.question.id === "q2"
        ? "Fixture content disagreement."
        : "The saved answer matches the expected value.",
    usage: { inputTokens: 30, outputTokens: 10, costUsd: 0 },
  }),
  researcher: async (input) => {
    turn++;
    return {
      conversationId: input.conversationId ?? "fixture-conversation",
      message:
        turn === 1
          ? "Try a narrower query strategy."
          : "Keep this candidate and finish the bounded fixture.",
      disposition: "keep",
      control: turn === 1 ? "continue" : "stop",
      ...(turn === 1
        ? { proposal: { ...agent, systemPrompt: "Candidate fixture" } }
        : {}),
      usage: { inputTokens: 40, outputTokens: 15, costUsd: 0 },
    };
  },
  classifier: {
    resolveConnection: async (connectionId) => ({
      connectionId,
      provider: "typesafe",
      settings: {},
      credentialFields: ["apiKey"],
    }),
    evaluate: async (input) => {
      const request = jsonSchema.parse({
        state: input.evidence,
        questions: input.criteria.checks,
        model: input.configuration.model,
      });
      input.onRequest(request);
      if (input.evidence.question.id === "q4")
        throw Object.assign(Error("Fixture HTTP 400 max_tokens_exceeded"), {
          code: "max_tokens_exceeded",
          httpStatus: 400,
          request,
          response: { error: "max_tokens_exceeded" },
        });
      const choice =
        input.evidence.question.id === "q2" ? "incorrect" : "acceptable";
      const check = (value: string) => ({
        choice: value,
        probabilities: { [value]: 0.96 },
        confidence: 0.96,
      });
      return {
        request,
        response: { fixture: true },
        model: "jev-fixture",
        checks: {
          answer: check(choice),
          evidence: check("supported"),
          reference: check("consistent"),
        },
        usage: { inputTokens: 60, outputTokens: 4, costUsd: 0 },
      };
    },
  },
};
const app = await createApplication({ dataDirectory: directory, runtime });
try {
  const existing = await app.execute("workspace.get", {});
  if (existing.banks.some((bank) => bank.name === "Observation fixture bank")) {
    process.stdout.write(
      JSON.stringify({
        directory,
        reused: true,
        runs: existing.runs.map((r) => ({ id: r.id, name: r.name })),
      }),
    );
  } else {
    const bank = await app.execute("banks.create", {
      name: "Observation fixture bank",
      questions: [
        { id: "q1", text: "What is the reported total?", expected: 42 },
        { id: "q2", text: "What is the alternate total?", expected: 42 },
        { id: "q3", text: "What is the final total?", expected: 42 },
        { id: "q4", text: "What is the archived total?", expected: 42 },
      ],
    });
    const profile = await app.execute("jev.profiles.publish", {
      bankId: bank.bankId,
      name: "Fixture Jev profile",
      settings: jevProfileSettingsSchema.parse({}),
      activate: true,
    });
    const session = await app.execute("research.launch", {
      name: "Bounded research fixture",
      baseline: {
        name: "Baseline fixture",
        bankRevisionId: bank.id,
        agent,
        judge: { enabled: true, agent: { ...agent, model: "fixture-judge" } },
        jevJudge: {
          connectionId: "fixture-jev",
          profileRevisionId: profile.id,
        },
      },
      researcher: { ...agent, model: "fixture-researcher" },
      objective: "Improve fixed eligible outcome",
      maxCandidates: 2,
      maxResearcherTurns: 3,
    });
    await app.waitForIdle();
    const research = await app.execute("research.get", {
      sessionId: session.session.id,
    });
    const runId = research.session.currentRunId;
    const deterministic = await app.execute("runs.assess", {
      runId,
      name: "Published deterministic standard",
      source: "deterministic",
    });
    await app.execute("runs.assess", {
      runId,
      name: "Second Jev assessment",
      source: "jev",
    });
    await app.execute("runs.assess", {
      runId,
      name: "Custom LLM assessment",
      source: "llm",
      judge: {
        enabled: true,
        agent: { ...agent, model: "fixture-judge" },
        instructions: "Accept equivalent numeric content.",
      },
    });
    const failed = deterministic.judgments.find((j) => !j.attemptId)!;
    await app.execute("runs.review-assessment", {
      runId,
      parentPassId: deterministic.id,
      name: "Human review with execution note",
      overrides: [
        {
          resultId: failed.resultId,
          verdict: null,
          note: "Inspect the saved transport failure before retrying.",
        },
      ],
    });
    await app.execute("banks.report-finding", {
      bankId: bank.bankId,
      bankRevisionId: bank.id,
      questionId: "q2",
      kind: "ambiguity",
      title: "Verify the alternate total definition",
      note: "The saved answer differs from the reference by one.",
      runId,
      resultId: deterministic.judgments[1]!.resultId,
      passId: deterministic.id,
    });
    await app.execute("banks.create", {
      name: "Answer size fixture bank",
      questions: [
        { id: "small", text: "A short answer", expected: "Short answer" },
        {
          id: "large",
          text: "A large expected answer",
          expected: "reference token ".repeat(1200),
        },
        {
          id: "oversize",
          text: "A reference that exceeds the Jev state estimate",
          expected: "reference token ".repeat(12000),
        },
      ],
    });
    process.stdout.write(
      JSON.stringify({ directory, runId, sessionId: research.session.id }),
    );
  }
} finally {
  await app.close();
}
