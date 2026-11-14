import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createApplication } from "../../src/application/application.js";
import {
  agentSchema,
  commandSchemas,
  type Json,
  type RunView,
  type RuntimePort,
} from "../../src/contracts.js";
import { digest } from "../../src/domain/identity.js";
import { startServer } from "../../src/server.js";
import { Database } from "../../src/storage/database.js";
import { targetFixture } from "../fixtures/runtime-targets.js";
import { recordHistoricalRetry } from "../fixtures/historical-retry.js";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function fixture(answers: Json[] = [42, null, { rows: [["saved", 7]] }]) {
  const directory = await mkdtemp(join(tmpdir(), "aeh-selected-answer-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const execute = vi.fn<RuntimePort["execute"]>(async ({ question }) => ({
    answer: answers[Number(question.id.slice(1)) - 1]!,
    text: "ORIGINAL_RESPONSE_" + "T".repeat(64_000),
    transcript: [{ type: "assistant", text: "SEALED_TRANSCRIPT" }],
  }));
  const judge = vi.fn(async () => ({ verdict: true, explanation: "Unused" }));
  const unused = async () => {
    throw Error("Unexpected provider invocation");
  };
  const runtime: RuntimePort = {
    ...targetFixture,
    execute,
    judge,
    resolveAgent: async (agent) => agent,
    recover: async () => ({ recovered: [], errors: [] }),
    close: async () => {},
    discover: unused,
    researcher: unused,
    listConnections: async () => [],
    saveConnection: unused,
    deleteConnection: unused,
    testConnection: unused,
  };
  const application = await createApplication({
    dataDirectory: directory,
    runtime,
  });
  const server = await startServer({ application, port: 0, host: "127.0.0.1" });
  cleanups.push(() => server.close());
  const db = new Database(join(directory, "workspace.sqlite"));
  cleanups.push(() => db.close());
  const reader = new DatabaseSync(join(directory, "workspace.sqlite"));
  cleanups.push(() => reader.close());
  const post = async (operation: string, input: unknown) => {
    const response = await fetch(`${server.url}/api/commands/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: await response.json() };
  };
  const bank = await application.execute(
    "banks.create",
    commandSchemas["banks.create"].parse({
      name: "Saved answer reads",
      questions: answers.map((expected, i) => ({
        id: `q${i + 1}`,
        text: `Value ${i + 1}?`,
        expected,
      })),
    }),
  );
  const launch = async () => {
    const launched = await application.execute("runs.launch", {
      bankRevisionId: bank.id,
      agent: agentSchema.parse({ harness: "codex", model: "fixture" }),
    });
    await application.waitForIdle();
    return application.execute("runs.get", { runId: launched.run.id });
  };
  const view = await launch();
  const input = (view: RunView, index = 0) => ({
    runId: view.run.id,
    attemptId: view.attempts[index]!.id,
    expectedEvidenceHash: view.attempts[index]!.evidenceHash!,
  });
  const allowCorruption = () => {
    // Corruption probes deliberately bypass immutable-record triggers in this disposable database.
    for (const row of reader
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
      .all())
      reader.exec(`DROP TRIGGER ${JSON.stringify(row.name)}`);
  };
  const snapshot = () =>
    JSON.stringify({
      records: reader
        .prepare("SELECT kind,id,value FROM records ORDER BY kind,id")
        .all(),
      events: reader.prepare("SELECT * FROM events ORDER BY sequence").all(),
    });
  return {
    application,
    db,
    reader,
    post,
    view,
    launch,
    input,
    snapshot,
    execute,
    judge,
    answers,
    allowCorruption,
  };
}

it("returns exact typed answers over HTTP without reading assessments, changing evidence, or invoking providers", async () => {
  const f = await fixture();
  const before = f.snapshot();
  const assessmentReads = vi.spyOn(Database.prototype, "attemptAssessments");
  const jevReads = vi.spyOn(Database.prototype, "jevSummaries");
  const list = Database.prototype.list;
  const listReads = vi
    .spyOn(Database.prototype, "list")
    .mockImplementation(function (this: Database, kind, query) {
      if (
        ["assessment", "assessmentPass", "jevAssessment", "scoreSet"].includes(
          kind,
        )
      )
        throw Error("Answer reads must not load assessments");
      return list.call(this, kind, query);
    });
  for (const [index, answer] of f.answers.entries()) {
    const input = f.input(f.view, index);
    const response = await f.post("runs.answer", input);
    expect(response).toEqual({
      status: 200,
      body: {
        attemptId: input.attemptId,
        evidenceHash: input.expectedEvidenceHash,
        answer,
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("ORIGINAL_RESPONSE_");
  }
  expect(assessmentReads).not.toHaveBeenCalled();
  expect(jevReads).not.toHaveBeenCalled();
  listReads.mockRestore();
  const full = await f.post("runs.attempt", f.input(f.view));
  expect(full.status).toBe(200);
  expect(full.body.attempt.output.text).toContain("ORIGINAL_RESPONSE_");
  expect(full.body.attempt.output.transcript[0].text).toBe("SEALED_TRANSCRIPT");
  expect(full.body.assessments).not.toHaveLength(0);
  expect(full.body).toHaveProperty("jevAssessments");
  expect(f.snapshot()).toBe(before);
  expect(f.execute).toHaveBeenCalledTimes(3);
  expect(f.judge).not.toHaveBeenCalled();
});

it("requires the selected sealed hash and rejects missing, wrong, unfinished, and tampered evidence", async () => {
  const f = await fixture([42]);
  const input = f.input(f.view);
  expect(
    (
      await f.post("runs.answer", {
        runId: input.runId,
        attemptId: input.attemptId,
      })
    ).status,
  ).toBe(400);
  expect(
    (await f.post("runs.answer", { ...input, expectedEvidenceHash: "wrong" }))
      .status,
  ).toBe(409);
  const original = f.db.require("attempt", input.attemptId);
  f.allowCorruption();
  // Simulate corrupted persisted bytes, bypassing the storage writer's seals.
  for (const change of [
    { output: { ...original.output!, text: "tampered" } },
    { evidenceHash: undefined },
    { status: "failed" },
    { output: undefined },
  ]) {
    f.reader
      .prepare("UPDATE records SET value=? WHERE kind='attempt' AND id=?")
      .run(JSON.stringify({ ...original, ...change }), input.attemptId);
    const response = await f.post("runs.answer", input);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("conflict");
  }
  expect(f.execute).toHaveBeenCalledTimes(1);
});

it("authorizes only owned or explicitly adopted compatible question and repetition evidence", async () => {
  const f = await fixture([42]);
  const child = await f.launch();
  const physical = f.input(child);
  const logical = { ...physical, runId: f.view.run.id };
  expect((await f.post("runs.answer", logical)).status).toBe(404);
  recordHistoricalRetry(f.db, f.view.run.id, child.run.id, [
    f.view.results[0]!.id,
  ]);
  const before = f.snapshot();
  expect(await f.post("runs.answer", logical)).toEqual({
    status: 200,
    body: {
      attemptId: physical.attemptId,
      evidenceHash: physical.expectedEvidenceHash,
      answer: 42,
    },
  });
  expect(f.snapshot()).toBe(before);
  const childRun = f.db.require("run", child.run.id);
  const result = f.db.require("result", child.results[0]!.id);
  f.allowCorruption();
  for (const mismatch of ["configuration", "repetition"] as const) {
    f.reader
      .prepare("UPDATE records SET value=? WHERE kind='run' AND id=?")
      .run(
        JSON.stringify({
          ...childRun,
          ...(mismatch === "configuration"
            ? {
                manifest: {
                  ...childRun.manifest,
                  digest: digest("different configuration"),
                },
              }
            : {}),
        }),
        child.run.id,
      );
    f.reader
      .prepare("UPDATE records SET value=? WHERE kind='result' AND id=?")
      .run(
        JSON.stringify({
          ...result,
          ...(mismatch === "repetition" ? { repetition: 2 } : {}),
        }),
        result.id,
      );
    const response = await f.post("runs.answer", logical);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("incompatible_basis");
  }
  expect(f.execute).toHaveBeenCalledTimes(2);
  expect(f.judge).not.toHaveBeenCalled();
});
