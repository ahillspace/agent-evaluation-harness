import { targetFixture } from "../fixtures/runtime-targets.js";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  jevProfileSettingsSchema,
  type CommandName,
  type CommandResultMap,
  type Json,
  type JudgeEvidence,
  type RuntimePort,
} from "../../src/contracts.js";
import { createApplication } from "../../src/application/application.js";
import { startServer } from "../../src/server.js";
import { Database } from "../../src/storage/database.js";

const executeFile = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(
  eventCount = 1,
  questionCount = 1,
  largeExchanges = false,
) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "aeh-jev-transport-"));
  cleanups.push(() => rm(dataDirectory, { recursive: true, force: true }));
  const calls = { target: 0, llm: 0, jev: 0 };
  const evidence: JudgeEvidence[] = [];
  const runtime: RuntimePort = {
    recover: async () => ({ recovered: [], errors: [] }),
    close: async () => {},
    discover: async () => ({
      harnesses: [],
      connectionProviders: [],
      maxConcurrency: 1,
    }),
    listConnections: async () => [],
    saveConnection: async () => {
      throw new Error("Unused operation");
    },
    deleteConnection: async () => {},
    testConnection: async () => ({ ok: true, message: "Fixture only" }),
    ...targetFixture,
    resolveAgent: async (agent) => structuredClone(agent),
    execute: async (input) => {
      calls.target++;
      expect(input.question).not.toHaveProperty("expected");
      input.onEvent({
        type: "tool.completed",
        message: "Fixture event 0",
        data: { index: 0, answer: 42 },
      });
      if (eventCount > 2) {
        const history = new Database(join(dataDirectory, "workspace.sqlite"));
        try {
          // Keep real stored history while batching the bulk fixture writes.
          history.transaction(() => {
            for (let index = 1; index < eventCount - 1; index++)
              history.append({
                runId: input.runId,
                attemptId: input.attemptId,
                type: "tool.completed",
                message: `Fixture event ${index}`,
                data: { index, answer: 42 },
              });
          });
        } finally {
          history.close();
        }
      }
      if (eventCount > 1) {
        const index = eventCount - 1;
        input.onEvent({
          type: "tool.completed",
          message: `Fixture event ${index}`,
          data: { index, answer: 42 },
        });
      }
      return {
        answer: 42,
        text: "42",
        usage: { inputTokens: 10, outputTokens: 1 },
      };
    },
    judge: async () => {
      calls.llm++;
      return {
        verdict: true,
        explanation: "LLM fixture verdict",
        usage: { inputTokens: 10, outputTokens: 1 },
      };
    },
    researcher: async () => {
      throw new Error("Unused operation");
    },
    classifier: {
      resolveConnection: async (connectionId) => ({
        connectionId,
        provider: "typesafe",
        settings: {},
        credentialFields: ["apiKey"],
      }),
      evaluate: async (input) => {
        calls.jev++;
        evidence.push(structuredClone(input.evidence));
        const request = JSON.parse(
          JSON.stringify({
            state: input.evidence,
            instructions: input.criteria.instructions,
            ...(largeExchanges
              ? { marker: `request-${calls.jev}`, padding: "x".repeat(262_144) }
              : {}),
          }),
        ) as Json;
        input.onRequest(request);
        const checks = {
          answer: {
            choice: "acceptable",
            probabilities: {
              acceptable: 0.96,
              incorrect: 0.02,
              insufficient_evidence: 0.02,
            },
            confidence: 0.94,
          },
          evidence: {
            choice: "supported",
            probabilities: {
              supported: 0.96,
              contradicted: 0.02,
              insufficient_evidence: 0.02,
            },
            confidence: 0.94,
          },
          reference: {
            choice: "consistent",
            probabilities: {
              consistent: 0.96,
              suspected_issue: 0.02,
              unknown: 0.02,
            },
            confidence: 0.94,
          },
        };
        return {
          request,
          response: {
            model: "jev-1.13.0",
            checks,
            ...(largeExchanges
              ? {
                  marker: `response-${calls.jev}`,
                  padding: "y".repeat(262_144),
                }
              : {}),
          },
          model: "jev-1.13.0",
          checks,
          usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.0000042 },
        };
      },
    },
  };
  const application = await createApplication({ dataDirectory, runtime });
  const server = await startServer({ application, port: 0 });
  cleanups.push(() => server.close());
  async function post<K extends CommandName>(
    operation: K,
    input: unknown,
  ): Promise<CommandResultMap[K]> {
    const response = await fetch(`${server.url}/api/commands/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = (await response.json()) as CommandResultMap[K];
    expect(response.ok, JSON.stringify(body)).toBe(true);
    return body;
  }
  async function cli<K extends CommandName>(
    operation: K,
    input: unknown,
  ): Promise<CommandResultMap[K]> {
    const output = await executeFile(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("src/cli.ts"),
        operation,
        "--url",
        server.url,
        "--json",
        JSON.stringify(input),
      ],
      { windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
    );
    return JSON.parse(output.stdout) as CommandResultMap[K];
  }
  const bank = await post("banks.create", {
    name: "Jev transport fixture",
    questions: Array.from({ length: questionCount }, (_, index) => ({
      id: `q${index + 1}`,
      text: `Return the count ${index + 1}`,
      expected: 42,
    })),
  });
  const profile = await post("jev.profiles.publish", {
    bankId: bank.bankId,
    name: "Reviewed criteria",
    settings: jevProfileSettingsSchema.parse({
      instructions: "Use the reference and recorded tool evidence.",
    }),
  });
  const selection = {
    connectionId: "typesafe-fixture",
    profileRevisionId: profile.id,
    model: "jev-1.13.0",
  };
  const agent = {
    harness: "codex",
    model: "fixture-model",
    systemPrompt: "Return the count.",
    tools: [],
    connections: [],
  };
  return {
    application,
    server,
    calls,
    evidence,
    post,
    cli,
    bank,
    profile,
    selection,
    agent,
    dataDirectory,
    runtime,
  };
}

it("keeps ordinary score inspection thin while authorized Jev inspection and export preserve all exchanges", async () => {
  const app = await fixture(1, 3, true);
  const launched = await app.post("runs.launch", {
    bankRevisionId: app.bank.id,
    agent: app.agent,
    judge: { enabled: true, agent: app.agent },
    jevJudge: app.selection,
  });
  await app.application.waitForIdle();
  const view = await app.post("runs.get", { runId: launched.run.id });
  const jev = view.assessmentPasses!.find((pass) => pass.source === "jev")!;
  const context = {
    runId: view.run.id,
    passId: jev.id,
    expectedObservationRevision: jev.observationRevision,
  };
  const exported = await app.post("runs.export-assessment", context);
  expect(exported.judgments).toHaveLength(3);
  for (const [index, judgment] of exported.judgments.entries()) {
    expect(judgment.request).toHaveProperty("marker", `request-${index + 1}`);
    expect(judgment.response).toHaveProperty("marker", `response-${index + 1}`);
  }
  const review = await app.post("runs.review-assessment", {
    runId: context.runId,
    parentPassId: jev.id,
    expectedObservationRevision: jev.observationRevision,
    name: "Inherited Jev exchanges",
    overrides: [{ resultId: jev.judgments[0]!.resultId, verdict: false }],
  });
  expect(review.judgments[0]).toHaveProperty("request");
  const llm = view.assessmentPasses!.find((pass) => pass.source === "llm")!;
  const llmReview = await app.post("runs.review-assessment", {
    runId: context.runId,
    parentPassId: llm.id,
    name: "Inherited LLM exchange",
    overrides: [],
  });
  const reader = new DatabaseSync(join(app.dataDirectory, "workspace.sqlite"), {
    readOnly: true,
  });
  cleanups.push(async () => reader.close());
  const saved = () =>
    JSON.stringify({
      records: reader
        .prepare("SELECT kind,id,value FROM records ORDER BY kind,id")
        .all(),
      events: reader.prepare("SELECT * FROM events ORDER BY sequence").all(),
    });
  const before = saved();
  const observations = (
    await app.post("runs.observe", { runId: context.runId })
  ).assessmentPasses!;
  const reads = vi.spyOn(Database.prototype, "get");
  const jevReads = () =>
    reads.mock.calls.filter(([kind]) => kind === "jevAssessment");
  for (const passId of [jev.id, review.id]) {
    reads.mockClear();
    const inspection = await app.post("runs.assessment", {
      runId: context.runId,
      passId,
    });
    expect(Object.keys(inspection).sort()).toEqual([
      "configuration",
      "judgments",
      "observationRevision",
    ]);
    expect(inspection.configuration).toEqual(exported.configuration);
    expect(inspection.judgments).toHaveLength(3);
    expect(
      inspection.judgments.map(
        ({ details: _details, ...metadata }) => metadata,
      ),
    ).toEqual(observations.find((pass) => pass.id === passId)!.judgments);
    for (const judgment of inspection.judgments) {
      expect(judgment).not.toHaveProperty("request");
      expect(judgment).not.toHaveProperty("response");
      expect(judgment.jevAssessmentStatus).toBe("completed");
    }
    expect(JSON.stringify(inspection)).not.toContain("request-1");
    expect(jevReads()).toHaveLength(0);
  }
  reads.mockClear();
  const record = await app.post("jev.get", {
    assessmentId: jev.judgments[0]!.jevAssessmentId!,
    assessmentContext: context,
  });
  expect(jevReads()).toHaveLength(1);
  expect(record.request).toEqual(exported.judgments[0]!.request);
  expect(record.response).toEqual(exported.judgments[0]!.response);
  expect(JSON.stringify(record)).not.toContain("request-2");
  for (const passId of [llm.id, llmReview.id]) {
    const full = await app.post("runs.export-assessment", {
      runId: context.runId,
      passId,
    });
    const inspection = await app.post("runs.assessment", {
      runId: context.runId,
      passId,
    });
    expect(full.judgments[0]!.request).toBeDefined();
    expect(inspection.judgments).toEqual(full.judgments);
  }
  reads.mockClear();
  const stale = await fetch(`${app.server.url}/api/commands/runs.assessment`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...context, expectedObservationRevision: "stale" }),
  });
  expect(stale.status).toBe(409);
  expect(jevReads()).toHaveLength(0);
  expect(await app.post("runs.export-assessment", context)).toEqual(exported);
  expect(saved()).toBe(before);
  expect(app.calls).toEqual({ target: 3, llm: 3, jev: 3 });
});

it("inspects corrected frozen references and evaluator details rather than the Run's original basis", async () => {
  const app = await fixture();
  const launched = await app.post("runs.launch", {
    bankRevisionId: app.bank.id,
    agent: app.agent,
  });
  await app.application.waitForIdle();
  const corrected = await app.post("banks.publish", {
    bankId: app.bank.bankId,
    baseRevisionId: app.bank.id,
    baseEvaluatorRevisionId: launched.run.manifest.evaluator.id,
    name: "Corrected reference",
    evaluatorName: "Corrected numeric rules",
    evaluatorSettings: { mode: "numeric", absoluteTolerance: 0.1 },
    questions: [{ id: "q1", text: "Return the count 1", expected: 43 }],
  });
  const pass = await app.post("runs.assess", {
    runId: launched.run.id,
    name: "Corrected saved basis",
    source: "deterministic",
    bankRevisionId: corrected.revision.id,
    evaluatorRevisionId: corrected.evaluatorRevision.id,
  });
  const inspection = await app.post("runs.assessment", {
    runId: launched.run.id,
    passId: pass.id,
  });
  expect(inspection.configuration.referenceBank).toEqual(corrected.revision);
  expect(inspection.configuration.evaluator).toEqual(
    corrected.evaluatorRevision,
  );
  expect(inspection.configuration.referenceBank!.id).not.toBe(
    launched.run.manifest.bank.id,
  );
  expect(inspection.configuration.evaluator!.id).not.toBe(
    launched.run.manifest.evaluator.id,
  );
  expect(inspection.judgments[0]!.status).toBe("incorrect");
  expect(pass.judgments[0]!.details).toBeDefined();
  expect(inspection.judgments[0]!.details).toEqual(pass.judgments[0]!.details);
});

it("preserves a finding's exact pending Jev exchange after the canonical record completes", async () => {
  const app = await fixture();
  const evaluate = app.runtime.classifier!.evaluate;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.runtime.classifier!.evaluate = async (input) => {
    input.onRequest({ marker: "CAPTURED_PENDING_REQUEST" });
    entered();
    await gate;
    return evaluate(input);
  };
  try {
    const launched = await app.post("runs.launch", {
      bankRevisionId: app.bank.id,
      agent: app.agent,
      jevJudge: app.selection,
    });
    await started;
    const running = await app.post("runs.get", { runId: launched.run.id });
    const original = running.assessmentPasses!.find(
      (pass) => pass.source === "jev",
    )!;
    const finding = await app.post("banks.report-finding", {
      bankId: app.bank.bankId,
      bankRevisionId: app.bank.id,
      questionId: "q1",
      runId: running.run.id,
      resultId: running.results[0]!.id,
      passId: original.id,
      kind: "reference",
      title: "Captured pending request",
    });
    const frozen = (
      await app.post("runs.get", { runId: running.run.id })
    ).assessmentPasses!.find((pass) => pass.id === finding.passId)!;
    const context = {
      runId: running.run.id,
      passId: frozen.id,
      expectedObservationRevision: frozen.observationRevision,
    };
    const captured = await app.post("runs.export-assessment", context);
    expect(captured.judgments[0]).toHaveProperty(
      "request.marker",
      "CAPTURED_PENDING_REQUEST",
    );
    expect(captured.judgments[0]).not.toHaveProperty("response");
    release();
    await app.application.waitForIdle();
    const inspection = await app.post("runs.assessment", context);
    expect(inspection.judgments[0]).toHaveProperty(
      "jevAssessmentStatus",
      "pending",
    );
    expect(inspection.judgments[0]).not.toHaveProperty("request");
    const later = await app.post("jev.get", {
      assessmentId: frozen.judgments[0]!.jevAssessmentId!,
    });
    expect(later.status).toBe("completed");
    expect(later.response).toBeDefined();
    const contextual = await fetch(`${app.server.url}/api/commands/jev.get`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        assessmentId: later.id,
        assessmentContext: context,
      }),
    });
    expect(contextual.status).toBe(409);
    expect(await app.post("runs.export-assessment", context)).toEqual(captured);
    expect(app.calls).toEqual({ target: 1, llm: 0, jev: 1 });
  } finally {
    release();
    await app.application.waitForIdle();
  }
});

describe("Jev browser and agent operations", () => {
  it("records independent live judges without changing the deterministic score", async () => {
    const app = await fixture();
    const launched = await app.post("runs.launch", {
      bankRevisionId: app.bank.id,
      agent: app.agent,
      judge: { enabled: true, agent: app.agent },
      jevJudge: app.selection,
    });
    await app.application.waitForIdle();
    const run = await app.post("runs.get", { runId: launched.run.id });
    expect(app.calls).toEqual({ target: 1, llm: 1, jev: 1 });
    expect(run.assessmentPasses![0]?.judgments[0]?.status).toBe("correct");
    expect(
      run.assessmentPasses!.find((pass) => pass.source === "llm")?.judgments[0]
        ?.status,
    ).toBe("correct");
    expect(run.jevAssessments).toHaveLength(1);
    expect(run.jevAssessments[0]?.published).toBe(true);
    expect(run.jevAssessments[0]?.checks?.answer.choice).toBe("acceptable");
    expect(run.jevAssessments[0]).not.toHaveProperty("request");
    expect(JSON.stringify(app.evidence[0])).not.toContain(
      "LLM fixture verdict",
    );
    const exported = await app.post("runs.export-agent", { runId: run.run.id });
    expect(JSON.stringify(exported)).not.toContain("Reviewed criteria");
    expect(JSON.stringify(exported)).not.toContain("typesafe-fixture");
  });

  it("previews complete saved events and publishes through CLI without more inference", async () => {
    const app = await fixture(5_005);
    const launched = await app.post("runs.launch", {
      bankRevisionId: app.bank.id,
      agent: app.agent,
    });
    await app.application.waitForIdle();
    const run = await app.post("runs.get", { runId: launched.run.id });
    const attemptId = run.results[0]!.completedAttemptId!;
    const input = {
      runId: run.run.id,
      attemptId,
      configuration: app.selection,
      idempotencyKey: "same-preview",
    };
    const preview = await app.post("jev.preview", input);
    expect(preview.status).toBe("completed");
    expect(preview.published).toBe(false);
    expect(preview.request).toBeDefined();
    expect(preview.response).toBeDefined();
    expect(preview.evidence.trace.format).toBe("recorded_events");
    const serialized = JSON.stringify(preview.evidence.trace.entries);
    expect(serialized).toContain("Fixture event 0");
    expect(serialized).toContain("Fixture event 5004");
    expect(serialized).not.toContain("evaluation.completed");
    const repeated = await app.cli("jev.preview", input);
    expect(repeated.id).toBe(preview.id);
    await app.post("jev.profiles.publish", {
      bankId: app.bank.bankId,
      name: "New future criteria",
      settings: {
        instructions: "Different instructions for future assessments.",
      },
    });
    const published = await app.cli("jev.publish", {
      assessmentId: preview.id,
    });
    expect(published.published).toBe(true);
    expect(published.configurationHash).toBe(preview.configurationHash);
    expect(published.request).toEqual(preview.request);
    expect(published.response).toEqual(preview.response);
    expect(published.configuration.profile.id).toBe(app.profile.id);
    expect(app.calls).toEqual({ target: 1, llm: 0, jev: 1 });
    const final = await app.post("runs.get", { runId: run.run.id });
    expect(final.assessmentPasses).toEqual(run.assessmentPasses);
  }, 30_000);
});
