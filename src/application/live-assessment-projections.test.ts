import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  agentSchema,
  jevProfileSettingsSchema,
  evaluatorSettingsSchema,
  type CommandInput,
  type CommandName,
  type CommandResultMap,
  type RuntimePort,
} from "../contracts.js";
import { Database } from "../storage/database.js";
import { startServer } from "../server.js";
import { targetFixture } from "../../tests/fixtures/runtime-targets.js";
import { createApplication } from "./application.js";
import { digest } from "../domain/identity.js";
import { recordHistoricalRetry } from "../../tests/fixtures/historical-retry.js";

it("polls live first and recovery automatic scores over HTTP without reading evidence bodies or frozen configurations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeh-live-projections-"));
  const admissions: Array<() => void> = [];
  const held = [0, 1].map(
    () => new Promise<void>((resolve) => admissions.push(resolve)),
  );
  const releases: Array<() => void> = [];
  const gates = [0, 1].map(
    () => new Promise<void>((resolve) => releases.push(resolve)),
  );
  let judgeEntered!: () => void;
  const judgeHeld = new Promise<void>((resolve) => {
    judgeEntered = resolve;
  });
  let releaseJudge!: () => void;
  const judgeGate = new Promise<void>((resolve) => {
    releaseJudge = resolve;
  });
  let heldCalls = 0;
  const runtime: RuntimePort = {
    ...targetFixture,
    resolveAgent: async (agent) => agent,
    recover: async () => ({ recovered: [], errors: [] }),
    close: async () => {},
    discover: async () => ({
      harnesses: [],
      connectionProviders: [],
      maxConcurrency: 1,
    }),
    listConnections: async () => [],
    saveConnection: async () => {
      throw new Error("Unused");
    },
    deleteConnection: async () => {},
    testConnection: async () => ({ ok: true, message: "Fixture" }),
    execute: async (input) => {
      if (input.question.id === "adopted")
        throw Object.assign(
          new Error("Legacy answer is adopted before recovery."),
          { code: "target_failure" },
        );
      if (input.question.id === "held") {
        const index = heldCalls++;
        admissions[index]!();
        await gates[index];
        if (index === 0)
          throw new Error("First attempt fails after live polling.");
      }
      return { answer: 42, text: "PRIVATE_EVIDENCE".repeat(18_000) };
    },
    judge: async () => ({
      verdict: true,
      explanation: "Recorded verdict",
      usage: { inputTokens: 5, outputTokens: 1, costUsd: 0.01 },
    }),
    researcher: async () => {
      throw new Error("Unused");
    },
    classifier: {
      resolveConnection: async (connectionId) => ({
        connectionId,
        provider: "typesafe",
        settings: {},
        credentialFields: [],
      }),
      evaluate: async (input) => {
        input.onRequest({ fixture: true });
        if (input.evidence.question.id === "held") {
          judgeEntered();
          await judgeGate;
          throw Object.assign(new Error("Fixture judge capacity error"), {
            code: "fixture_capacity",
            request: { fixture: true },
            httpStatus: 422,
          });
        }
        return {
          request: { fixture: true },
          response: { fixture: true },
          model: "jev-1.13.0",
          checks: {
            answer: {
              choice: "acceptable",
              confidence: 1,
              probabilities: { acceptable: 1 },
            },
          },
          usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.01 },
        };
      },
    },
  };
  const app = await createApplication({ dataDirectory: directory, runtime });
  const server = await startServer({
    application: app,
    host: "127.0.0.1",
    port: 0,
  });
  const reader = new DatabaseSync(join(directory, "workspace.sqlite"));
  async function command<K extends CommandName>(
    operation: K,
    input: CommandInput<K>,
  ): Promise<CommandResultMap[K]> {
    const response = await fetch(`${server.url}/api/commands/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body as CommandResultMap[K];
  }
  const fullGet = Database.prototype.get;
  const fullList = Database.prototype.list;
  const reads: string[] = [];
  let watching = false;
  const getSpy = vi
    .spyOn(Database.prototype, "get")
    .mockImplementation(function (this: Database, kind, recordId) {
      if (
        watching &&
        [
          "run",
          "attempt",
          "assessment",
          "scoreSet",
          "assessmentPass",
          "jevAssessment",
        ].includes(kind)
      )
        reads.push(`get:${kind}`);
      return fullGet.call(this, kind, recordId);
    });
  const listSpy = vi
    .spyOn(Database.prototype, "list")
    .mockImplementation(function (this: Database, kind, query) {
      if (
        watching &&
        [
          "run",
          "attempt",
          "assessment",
          "scoreSet",
          "assessmentPass",
          "jevAssessment",
        ].includes(kind)
      )
        reads.push(`list:${kind}`);
      return fullList.call(this, kind, query);
    });
  const realParse = JSON.parse;
  const bodyReads: string[] = [];
  const parseSpy = vi
    .spyOn(JSON, "parse")
    .mockImplementation((text, reviver) => {
      if (
        watching &&
        (text.includes("PRIVATE_EVIDENCE".repeat(1000)) ||
          text.includes("PRIVATE_CONFIGURATION".repeat(1000)))
      )
        bodyReads.push(
          text.includes("PRIVATE_EVIDENCE".repeat(1000))
            ? "evidence"
            : "configuration",
        );
      return realParse(text, reviver);
    });
  const records = () =>
    JSON.stringify(
      reader
        .prepare("SELECT kind,id,value FROM records ORDER BY kind,id")
        .all(),
    );
  async function poll(runId: string) {
    const before = records();
    watching = true;
    reads.length = 0;
    bodyReads.length = 0;
    const page = await command("runs.list", {
      limit: 1,
      search: "Held logical Run",
    });
    const observed = await command("runs.observe", { runId });
    const workspace = await command("workspace.get", {});
    watching = false;
    expect(bodyReads, "Large body deserialization during live polling").toEqual(
      [],
    );
    expect(reads, "Full reads during live polling").toEqual([]);
    expect(records()).toBe(before);
    for (const value of [page, observed, workspace])
      expect(JSON.stringify(value)).not.toContain(
        "PRIVATE_EVIDENCE".repeat(1000),
      );
    expect(JSON.stringify(observed)).not.toContain("PRIVATE_CONFIGURATION");
    return { page, observed, workspace };
  }
  try {
    const bank = await command("banks.create", {
      name: "Live scores",
      evaluator: evaluatorSettingsSchema.parse({
        questionOverrides: {
          excluded: {
            referenceDisposition: "needs_review",
            referenceNote: "Fixture exclusion",
          },
        },
      }),
      questions: ["excluded", "body", "adopted", "held"].map((id) => ({
        id,
        text: `${id}?`,
        expected: 42,
      })),
    });
    await command("jev.profiles.publish", {
      bankId: bank.bankId,
      name: "Fixture",
      settings: jevProfileSettingsSchema.parse({}),
    });
    const agent = agentSchema.parse({
      harness: "codex",
      model: "fixture",
      systemPrompt: "PRIVATE_CONFIGURATION".repeat(4000),
    });
    const launched = await command("runs.launch", {
      bankRevisionId: bank.id,
      name: "Held logical Run",
      agent,
      judge: { enabled: true, agent },
      jevJudge: { connectionId: "fixture-jev" },
      limits: { concurrency: 1 },
    });
    const runId = launched.run.id;
    for (const phase of [0, 1]) {
      await held[phase];
      const { page, observed } = await poll(runId);
      const families = observed.assessmentPasses!.filter((pass) =>
        phase === 0
          ? pass.id.startsWith("original_")
          : pass.id.startsWith("automatic_"),
      );
      expect(families.map((pass) => pass.source)).toEqual([
        "deterministic",
        "llm",
        "jev",
      ]);
      for (const pass of families) {
        expect(pass.status).toBe("running");
        expect(pass.coverage).toMatchObject({
          eligible: 3,
          excluded: 1,
          answered: phase === 0 ? 1 : 2,
          correct: phase === 0 ? 1 : 2,
          unjudged: phase === 0 ? 2 : 1,
        });
        expect(
          page.runs[0]!.assessmentPasses!.find(
            (summary) => summary.id === pass.id,
          )?.coverage,
        ).toEqual(pass.coverage);
      }
      releases[phase]!();
      if (phase === 1) {
        await judgeHeld;
        const pending = (await poll(runId)).observed;
        const current = pending.assessmentPasses!.filter((pass) =>
          pass.id.startsWith("automatic_"),
        );
        for (const pass of current) {
          const judgment = pass.judgments.find(
            (item) =>
              item.resultId ===
              pending.results.find((result) => result.questionId === "held")!
                .id,
          )!;
          if (pass.source === "jev") {
            expect(judgment).toMatchObject({
              status: "unjudged",
              jevAssessmentStatus: "pending",
            });
            expect(pass.coverage).toMatchObject({
              answered: 3,
              correct: 2,
              unjudged: 1,
            });
          } else
            expect(pass.coverage).toMatchObject({
              answered: 3,
              correct: 3,
              unjudged: 0,
            });
        }
        releaseJudge();
      }
      await app.waitForIdle();
      if (phase === 0) {
        const db = new Database(join(directory, "workspace.sqlite"));
        try {
          const original = db.require("run", runId);
          const logical = db
            .list("result", { runId })
            .find((result) => result.questionId === "adopted")!;
          const originalAnswer = db
            .list("result", { runId })
            .find((result) => result.questionId === "body")!;
          const output = {
            answer: 42,
            text: "PRIVATE_EVIDENCE".repeat(18_000),
          };
          const physicalRunId = "legacy-physical-run";
          const physicalResultId = "legacy-physical-result";
          const attemptId = "legacy-physical-attempt";
          db.insert("run", {
            ...original,
            id: physicalRunId,
            name: "Historical evidence",
            execution: undefined,
          });
          db.insert("result", {
            id: physicalResultId,
            runId: physicalRunId,
            questionId: "adopted",
            repetition: 1,
            status: "completed",
            completedAttemptId: attemptId,
            attemptIds: [attemptId],
          });
          db.insert("attempt", {
            id: attemptId,
            runId: physicalRunId,
            resultId: physicalResultId,
            number: 1,
            status: "completed",
            startedAt: original.createdAt,
            finishedAt: original.updatedAt,
            output,
            evidenceHash: digest(output),
          });
          const assessment = db.list("assessment", {
            resultId: originalAnswer.id,
          })[0]!;
          db.insert("assessment", {
            ...assessment,
            id: "legacy-physical-raw",
            runId: physicalRunId,
            resultId: physicalResultId,
            attemptId,
          });
          const jev = db.list("jevAssessment", {
            resultId: originalAnswer.id,
          })[0]!;
          const evidence = {
            ...jev.evidence,
            runId: physicalRunId,
            resultId: physicalResultId,
            attemptId,
            question: { id: "adopted", text: "adopted?", tags: [] },
            finalText: output.text,
          };
          db.insert("jevAssessment", {
            ...jev,
            id: "legacy-physical-jev",
            runId: physicalRunId,
            resultId: physicalResultId,
            attemptId,
            evidence,
            evidenceHash: digest(evidence),
            attemptEvidenceHash: digest(output),
          });
          recordHistoricalRetry(db, runId, physicalRunId, [logical.id]);
        } finally {
          db.close();
        }
        await command("runs.retry-failed", {
          runId,
          idempotencyKey: "live-recovery",
          acknowledgeDuplicateWork: true,
        });
      }
    }
    const settled = (await poll(runId)).observed;
    const failedJudge = settled.assessmentPasses!.find((pass) =>
      pass.id.startsWith("automatic_jev_"),
    )!;
    expect(failedJudge.coverage).toMatchObject({
      answered: 3,
      correct: 2,
      errors: 1,
    });
    const error = failedJudge.judgments.find(
      (judgment) => judgment.status === "error",
    )!;
    expect(error).toMatchObject({
      jevAssessmentStatus: "error",
      explanation: "Fixture judge capacity error",
    });
    expect(error).not.toHaveProperty("error");
    const detail = await command("runs.assessment", {
      runId,
      passId: failedJudge.id,
      expectedObservationRevision: failedJudge.observationRevision,
    });
    expect(
      detail.judgments.find((judgment) => judgment.resultId === error.resultId),
    ).toMatchObject({ error: { code: "fixture_capacity", httpStatus: 422 } });
  } finally {
    watching = false;
    releaseJudge();
    for (const release of releases) release();
    parseSpy.mockRestore();
    getSpy.mockRestore();
    listSpy.mockRestore();
    reader.close();
    await server.close();
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}, 30_000);
