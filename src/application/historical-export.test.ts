import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { evaluatorSettingsSchema, type RuntimePort } from "../contracts.js";
import { digest } from "../domain/identity.js";
import { Database } from "../storage/database.js";
import { targetFixture } from "../../tests/fixtures/runtime-targets.js";
import { createApplication } from "./application.js";

it("exports historical published policy unchanged while rejecting it for new publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeh-historical-export-"));
  const db = new Database(join(directory, "workspace.sqlite"));
  const questions = [
    {
      id: "table",
      text: "Return counts",
      tags: [],
      expected: {
        type: "table",
        columns: [{ name: "n", type: "integer" }],
        rows: [{ n: 2 }, { n: 1 }],
      },
    },
  ];
  const settings = evaluatorSettingsSchema.parse({
    mode: "json",
    arrayOrderMatters: false,
    sortOrder: [{ column: "n", direction: "asc" }],
  });
  // Seed immutable records from before the authored-policy restriction.
  const revision = db.insert(
    "bankRevision",
    {
      id: "historical-bank-revision",
      bankId: "historical-bank",
      number: 1,
      name: "Historical bank",
      createdAt: "2026-10-01T00:00:00.000Z",
      questions,
      digest: digest(questions),
    },
    true,
  );
  const evaluator = db.insert(
    "evaluator",
    {
      id: "historical-evaluator",
      bankId: revision.bankId,
      number: 1,
      name: "Historical JSON policy",
      createdAt: revision.createdAt,
      settings,
      digest: digest(settings),
    },
    true,
  );
  const incompatibleQuestions = [
    { id: "table", text: "Return a count", tags: [], expected: 42 },
  ];
  const incompatible = db.insert(
    "bankRevision",
    {
      ...revision,
      id: "incompatible-bank-revision",
      number: 2,
      questions: incompatibleQuestions,
      digest: digest(incompatibleQuestions),
    },
    true,
  );
  db.insert("bank", {
    id: revision.bankId,
    name: revision.name,
    createdAt: revision.createdAt,
    latestRevisionId: revision.id,
    activeEvaluatorRevisionId: evaluator.id,
  });
  db.close();
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected provider call");
  };
  const runtime: RuntimePort = {
    ...targetFixture,
    execute: unused,
    judge: unused,
    researcher: unused,
    resolveAgent: async (value) => value,
    discover: async () => ({
      harnesses: [],
      connectionProviders: [],
      maxConcurrency: 1,
    }),
    recover: async () => ({ recovered: [], errors: [] }),
    close: async () => {},
    listConnections: async () => [],
    saveConnection: unused,
    deleteConnection: async () => {},
    testConnection: async () => ({ ok: true, message: "Fixture" }),
  };
  const app = await createApplication({ dataDirectory: directory, runtime });
  try {
    const exported = await app.execute("banks.export-package", {
      bankRevisionId: revision.id,
      evaluatorRevisionId: evaluator.id,
    });
    expect(exported).toMatchObject({
      questions: revision.questions,
      evaluator: { name: evaluator.name, settings },
      source: {
        bankRevisionId: revision.id,
        evaluatorRevisionId: evaluator.id,
      },
    });
    expect(
      await app.execute("banks.export", { bankRevisionId: revision.id }),
    ).toEqual(revision);
    await expect(
      app.execute("banks.export-package", {
        bankRevisionId: incompatible.id,
        evaluatorRevisionId: evaluator.id,
      }),
    ).rejects.toThrow(/declared table columns/);
    await expect(
      app.execute("banks.publish", {
        name: "Imported historical bank",
        questions: exported.questions,
        evaluatorName: exported.evaluator.name,
        evaluatorSettings: exported.evaluator.settings,
      }),
    ).rejects.toThrow(/Auto comparison with a typed table/);
    const saved = await app.execute("banks.get", { bankId: revision.bankId });
    expect(saved.revisions).toHaveLength(2);
    expect(saved.revisions.find((item) => item.id === revision.id)).toEqual(
      revision,
    );
    expect(saved.revisions.find((item) => item.id === incompatible.id)).toEqual(
      incompatible,
    );
    expect(saved.evaluatorRevisions).toEqual([evaluator]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
