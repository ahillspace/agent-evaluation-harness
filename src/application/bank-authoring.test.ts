import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { targetFixture } from "../../tests/fixtures/runtime-targets.js";
import type { AgentConfig, RuntimePort } from "../contracts.js";
import { createApplication } from "./application.js";

const agent: AgentConfig = {
  harness: "codex",
  model: "test",
  systemPrompt: "Answer.",
  settings: {},
  tools: [],
  connections: [],
};
const question = {
  id: "q1",
  text: "Round to one decimal place.",
  expected: 49.073755,
  tags: [],
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "aeh-bank-authoring-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const execute = vi.fn(async () => ({ answer: 49.1, text: "49.1" }));
  const judge = vi.fn(async () => {
    throw new Error("Unexpected judge call");
  });
  const runtime: RuntimePort = {
    ...targetFixture,
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
    execute,
    judge,
    researcher: async () => {
      throw new Error("Unused");
    },
  };
  const app = await createApplication({ dataDirectory: directory, runtime });
  cleanups.push(() => app.close());
  return { app, execute, judge };
}
const publish = {
  name: "Precision bank",
  questions: [question],
  evaluatorName: "Rounded values",
  evaluatorSettings: { decimalPlaces: 1 },
};

it("requires revision guards on every existing-bank publication route", async () => {
  const { app } = await setup();
  const first = await app.execute<"banks.publish">("banks.publish", publish);
  const before = await app.execute<"banks.get">("banks.get", {
    bankId: first.revision.bankId,
  });
  for (const operation of ["banks.revise", "banks.publish"] as const) {
    await expect(
      app.execute(operation, {
        ...(operation === "banks.publish" ? publish : {}),
        bankId: first.revision.bankId,
        name: "Unguarded overwrite",
        questions: [question],
      }),
    ).rejects.toThrow(/base|guard|revision/i);
  }
  expect(
    await app.execute<"banks.get">("banks.get", {
      bankId: first.revision.bankId,
    }),
  ).toEqual(before);
});

it("rejects a stale second editor through the public banks.revise contract", async () => {
  const { app } = await setup();
  const first = await app.execute<"banks.publish">("banks.publish", publish);
  const input = {
    bankId: first.revision.bankId,
    baseRevisionId: first.revision.id,
    baseEvaluatorRevisionId: first.evaluatorRevision.id,
    name: "First editor",
    questions: [{ ...question, expected: 50 }],
  };
  const second = await app.execute<"banks.revise">("banks.revise", input);
  await expect(
    app.execute<"banks.revise">("banks.revise", {
      ...input,
      name: "Stale editor",
    }),
  ).rejects.toThrow(/changed|conflict/i);
  const saved = await app.execute<"banks.get">("banks.get", {
    bankId: first.revision.bankId,
  });
  expect(saved.bank.latestRevisionId).toBe(second.id);
  expect(saved.revisions).toHaveLength(2);
  expect(saved.evaluatorRevisions).toHaveLength(2);
});

it("calibrates banks.create and banks.revise without partial publication", async () => {
  const { app } = await setup();
  const evaluator = {
    calibrationExamples: [
      {
        id: "known",
        questionId: "q1",
        answer: question.expected,
        expectedStatus: "correct" as const,
      },
    ],
  };
  await expect(
    app.execute<"banks.create">("banks.create", {
      name: "Invalid calibration",
      questions: [{ ...question, expected: 0 }],
      evaluator,
    }),
  ).rejects.toThrow(/calibration/i);
  expect(
    (await app.execute<"workspace.get">("workspace.get", {})).banks,
  ).toHaveLength(0);
  const first = await app.execute<"banks.create">("banks.create", {
    name: "Calibrated",
    questions: [question],
    evaluator,
  });
  const before = await app.execute<"banks.get">("banks.get", {
    bankId: first.bankId,
  });
  await expect(
    app.execute<"banks.revise">("banks.revise", {
      bankId: first.bankId,
      baseRevisionId: first.id,
      baseEvaluatorRevisionId: before.bank.activeEvaluatorRevisionId,
      name: first.name,
      questions: [{ ...question, expected: 0 }],
    }),
  ).rejects.toThrow(/calibration/i);
  expect(
    await app.execute<"banks.get">("banks.get", { bankId: first.bankId }),
  ).toEqual(before);
});

it.each(["correction", "exclusion"])(
  "rejects a historical %s for a changed question",
  async (action) => {
    const { app } = await setup();
    const first = await app.execute<"banks.publish">("banks.publish", publish);
    const finding = await app.execute<"banks.report-finding">(
      "banks.report-finding",
      {
        bankId: first.revision.bankId,
        bankRevisionId: first.revision.id,
        questionId: "q1",
        kind: "reference",
        title: "Review old task",
      },
    );
    await app.execute<"banks.publish">("banks.publish", {
      ...publish,
      bankId: first.revision.bankId,
      baseRevisionId: first.revision.id,
      baseEvaluatorRevisionId: first.evaluatorRevision.id,
      questions: [{ ...question, context: "A different reporting period" }],
    });
    const before = await app.execute<"banks.get">("banks.get", {
      bankId: first.revision.bankId,
    });
    await expect(
      app.execute<"banks.resolve-finding">("banks.resolve-finding", {
        findingId: finding.id,
        status: "accepted",
        ...(action === "correction" ? { expected: 50 } : { exclude: true }),
      }),
    ).rejects.toThrow(/changed|basis|question/i);
    expect(
      await app.execute<"banks.get">("banks.get", {
        bankId: first.revision.bankId,
      }),
    ).toEqual(before);
    expect(
      (
        await app.execute<"banks.findings">("banks.findings", {
          bankId: first.revision.bankId,
        })
      )[0]?.status,
    ).toBe("open");
  },
);

it("keeps a finding open when its correction fails calibration", async () => {
  const { app } = await setup();
  const first = await app.execute<"banks.publish">("banks.publish", {
    ...publish,
    evaluatorSettings: {
      calibrationExamples: [
        {
          id: "known",
          questionId: "q1",
          answer: question.expected,
          expectedStatus: "correct",
        },
      ],
    },
  });
  const finding = await app.execute<"banks.report-finding">(
    "banks.report-finding",
    {
      bankId: first.revision.bankId,
      bankRevisionId: first.revision.id,
      questionId: "q1",
      kind: "reference",
      title: "Reference correction",
    },
  );
  const before = await app.execute<"banks.get">("banks.get", {
    bankId: first.revision.bankId,
  });
  await expect(
    app.execute<"banks.resolve-finding">("banks.resolve-finding", {
      findingId: finding.id,
      status: "accepted",
      expected: 50,
    }),
  ).rejects.toThrow(/calibration/i);
  expect(
    await app.execute<"banks.get">("banks.get", {
      bankId: first.revision.bankId,
    }),
  ).toEqual(before);
  expect(
    (
      await app.execute<"banks.findings">("banks.findings", {
        bankId: first.revision.bankId,
      })
    )[0]?.status,
  ).toBe("open");
});

it("commits a finding decision with publication and rejects a competing decision", async () => {
  const { app } = await setup();
  const first = await app.execute<"banks.publish">("banks.publish", {
    ...publish,
    evaluatorSettings: {
      decimalPlaces: 1,
      calibrationExamples: [
        {
          id: "known",
          questionId: "q1",
          answer: 49.1,
          expectedStatus: "correct",
        },
      ],
    },
  });
  const finding = await app.execute<"banks.report-finding">(
    "banks.report-finding",
    {
      bankId: first.revision.bankId,
      bankRevisionId: first.revision.id,
      questionId: "q1",
      kind: "reference",
      title: "Reference rounding",
    },
  );
  const before = await app.execute<"banks.get">("banks.get", {
    bankId: first.revision.bankId,
  });
  const pending = app.execute<"banks.resolve-finding">(
    "banks.resolve-finding",
    {
      findingId: finding.id,
      status: "accepted",
      expected: 49.1,
    },
  );
  const outcomes = await Promise.allSettled([
    pending,
    app.execute<"banks.resolve-finding">("banks.resolve-finding", {
      findingId: finding.id,
      status: "dismissed",
    }),
  ]);
  expect(outcomes[0]).toMatchObject({
    status: "rejected",
    reason: { code: "conflict" },
  });
  expect(outcomes[1]?.status).toBe("fulfilled");
  expect(
    await app.execute<"banks.get">("banks.get", {
      bankId: first.revision.bankId,
    }),
  ).toEqual(before);
  expect(
    (
      await app.execute<"banks.findings">("banks.findings", {
        bankId: first.revision.bankId,
      })
    )[0]?.status,
  ).toBe("dismissed");
});

it("publishes questions and calibrated rules atomically and preserves frozen runs", async () => {
  const { app } = await setup();
  const first = await app.execute<"banks.publish">("banks.publish", publish);
  expect(first.revision.number).toBe(1);
  expect(first.evaluatorRevision.settings.decimalPlaces).toBe(1);
  const run = await app.execute<"runs.launch">("runs.launch", {
    bankRevisionId: first.revision.id,
    agent,
  });
  await app.waitForIdle();
  const before = await app.execute<"runs.get">("runs.get", {
    runId: run.run.id,
  });
  const second = await app.execute<"banks.publish">("banks.publish", {
    ...publish,
    bankId: first.revision.bankId,
    baseRevisionId: first.revision.id,
    baseEvaluatorRevisionId: first.evaluatorRevision.id,
    questions: [{ ...question, expected: 50 }],
    evaluatorSettings: {
      decimalPlaces: 0,
      calibrationExamples: [
        {
          id: "positive",
          questionId: question.id,
          answer: 50,
          expectedStatus: "correct",
        },
        {
          id: "negative",
          questionId: question.id,
          answer: 49,
          expectedStatus: "incorrect",
        },
      ],
    },
  });
  expect(second.revision.number).toBe(2);
  expect(second.evaluatorRevision.number).toBe(2);
  expect(second.evaluatorRevision.calibration).toMatchObject({
    bankRevisionId: second.revision.id,
    passed: 2,
    total: 2,
  });
  const detail = await app.execute<"banks.get">("banks.get", {
    bankId: first.revision.bankId,
  });
  expect(detail.bank).toMatchObject({
    latestRevisionId: second.revision.id,
    activeEvaluatorRevisionId: second.evaluatorRevision.id,
  });
  expect(detail.revisions[0]).toEqual(first.revision);
  expect(
    (await app.execute<"runs.get">("runs.get", { runId: run.run.id })).run
      .manifest,
  ).toEqual(before.run.manifest);
});

it("rejects failed calibration and invalid references without partial publication", async () => {
  const { app } = await setup();
  const first = await app.execute<"banks.publish">("banks.publish", publish);
  const before = await app.execute<"banks.get">("banks.get", {
    bankId: first.revision.bankId,
  });
  await expect(
    app.execute<"banks.publish">("banks.publish", {
      ...publish,
      bankId: first.revision.bankId,
      baseRevisionId: first.revision.id,
      baseEvaluatorRevisionId: first.evaluatorRevision.id,
      evaluatorSettings: {
        calibrationExamples: [
          {
            id: "bad",
            questionId: question.id,
            answer: 0,
            expectedStatus: "correct",
          },
        ],
      },
    }),
  ).rejects.toThrow(/calibration/i);
  await expect(
    app.execute<"banks.publish">("banks.publish", {
      ...publish,
      bankId: first.revision.bankId,
      baseRevisionId: first.revision.id,
      baseEvaluatorRevisionId: first.evaluatorRevision.id,
      questions: [
        {
          ...question,
          answerFormat: {
            type: "scalar",
            valueType: "boolean",
            nullable: false,
          },
        },
      ],
    }),
  ).rejects.toThrow(/format|reference/i);
  expect(
    await app.execute<"banks.get">("banks.get", {
      bankId: first.revision.bankId,
    }),
  ).toEqual(before);
});

it("rejects stale publication guards and changes during asynchronous calibration", async () => {
  const { app } = await setup();
  const first = await app.execute<"banks.publish">("banks.publish", publish);
  await expect(
    app.execute<"banks.publish">("banks.publish", {
      ...publish,
      bankId: first.revision.bankId,
      baseRevisionId: "stale",
      baseEvaluatorRevisionId: first.evaluatorRevision.id,
    }),
  ).rejects.toThrow(/changed|conflict|stale/i);
  const pending = app.execute<"banks.publish">("banks.publish", {
    ...publish,
    bankId: first.revision.bankId,
    baseRevisionId: first.revision.id,
    baseEvaluatorRevisionId: first.evaluatorRevision.id,
    evaluatorSettings: {
      decimalPlaces: 1,
      calibrationExamples: [
        {
          id: "positive",
          questionId: question.id,
          answer: 49.1,
          expectedStatus: "correct",
        },
      ],
    },
  });
  const rejected = expect(pending).rejects.toThrow(/changed|conflict/i);
  await app.execute<"banks.revise">("banks.revise", {
    bankId: first.revision.bankId,
    baseRevisionId: first.revision.id,
    baseEvaluatorRevisionId: first.evaluatorRevision.id,
    name: publish.name,
    questions: [question],
  });
  await rejected;
  const detail = await app.execute<"banks.get">("banks.get", {
    bankId: first.revision.bankId,
  });
  expect(detail.revisions).toHaveLength(2);
  expect(detail.evaluatorRevisions).toHaveLength(2);
});

it("checks an inline sample with per-question rules and custom code without provider calls or catalog writes", async () => {
  const { app, execute, judge } = await setup();
  const before = await app.execute<"workspace.get">("workspace.get", {});
  expect(
    await app.execute<"banks.check-answer">("banks.check-answer", {
      question,
      settings: { questionOverrides: { q1: { decimalPlaces: 1 } } },
      answer: 49.1,
    }),
  ).toMatchObject({ status: "correct" });
  expect(
    await app.execute<"banks.check-answer">("banks.check-answer", {
      question,
      settings: {},
      answer: 49.1,
    }),
  ).toMatchObject({ status: "incorrect" });
  expect(
    await app.execute<"banks.check-answer">("banks.check-answer", {
      question,
      settings: {
        questionOverrides: {
          q1: {
            mode: "custom",
            code: "return { verdict: input.answer === 123, explanation: 'Custom sample' };",
          },
        },
      },
      answer: 123,
    }),
  ).toMatchObject({ status: "correct", explanation: "Custom sample" });
  expect(await app.execute<"workspace.get">("workspace.get", {})).toEqual(
    before,
  );
  expect(execute).not.toHaveBeenCalled();
  expect(judge).not.toHaveBeenCalled();
});

it("calibrates the proposed questions and rejects unknown overrides without creating a bank", async () => {
  const { app, execute, judge } = await setup();
  const before = await app.execute<"workspace.get">("workspace.get", {});
  const report = await app.execute<"banks.calibrate-draft">(
    "banks.calibrate-draft",
    {
      questions: [question],
      settings: {
        decimalPlaces: 1,
        calibrationExamples: [
          {
            id: "rounded",
            questionId: "q1",
            answer: 49.1,
            expectedStatus: "correct",
          },
          {
            id: "wrong",
            questionId: "q1",
            answer: 49.0,
            expectedStatus: "incorrect",
          },
        ],
      },
    },
  );
  expect(report).toMatchObject({ total: 2, passed: 2 });
  expect(report.bankRevisionId).toMatch(/^draft_/);
  await expect(
    app.execute<"banks.calibrate-draft">("banks.calibrate-draft", {
      questions: [question],
      settings: { questionOverrides: { absent: { decimalPlaces: 1 } } },
    }),
  ).rejects.toThrow(/unknown question/i);
  await expect(
    app.execute<"banks.publish">("banks.publish", {
      ...publish,
      questions: [question, question],
    }),
  ).rejects.toThrow(/unique/i);
  expect(await app.execute<"workspace.get">("workspace.get", {})).toEqual(
    before,
  );
  expect(execute).not.toHaveBeenCalled();
  expect(judge).not.toHaveBeenCalled();
});

it("previews inline draft references and rules on sealed evidence without publishing or rerunning", async () => {
  const { app, execute, judge } = await setup();
  const first = await app.execute<"banks.publish">("banks.publish", {
    ...publish,
    evaluatorSettings: {},
  });
  const run = await app.execute<"runs.launch">("runs.launch", {
    bankRevisionId: first.revision.id,
    agent,
  });
  await app.waitForIdle();
  const catalogBefore = await app.execute<"banks.get">("banks.get", {
    bankId: first.revision.bankId,
  });
  const evidenceBefore = await app.execute<"runs.get">("runs.get", {
    runId: run.run.id,
  });
  const preview = await app.execute<"banks.preview-draft">(
    "banks.preview-draft",
    {
      bankId: first.revision.bankId,
      questions: [question],
      settings: { decimalPlaces: 1 },
      runIds: [run.run.id],
    },
  );
  expect(preview.runs[0]?.rows[0]).toMatchObject({
    questionId: "q1",
    answer: 49.1,
    before: { status: "incorrect" },
    after: { status: "correct" },
    changed: true,
  });
  expect(
    await app.execute<"banks.get">("banks.get", {
      bankId: first.revision.bankId,
    }),
  ).toEqual(catalogBefore);
  expect(
    (await app.execute<"runs.get">("runs.get", { runId: run.run.id })).attempts,
  ).toEqual(evidenceBefore.attempts);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(judge).not.toHaveBeenCalled();
  await expect(
    app.execute<"banks.preview-draft">("banks.preview-draft", {
      bankId: first.revision.bankId,
      questions: [{ ...question, context: "Changed task" }],
      settings: {},
      runIds: [run.run.id],
    }),
  ).rejects.toThrow(/question|context/i);
});

it("exports a versioned complete package and rejects cross-bank rule selections", async () => {
  const { app } = await setup();
  const first = await app.execute<"banks.publish">("banks.publish", publish);
  const profile = await app.execute<"jev.profiles.publish">(
    "jev.profiles.publish",
    {
      bankId: first.revision.bankId,
      name: "Answer criteria",
      settings: { instructions: "Assess correctness." },
    },
  );
  const exported = await app.execute<"banks.export-package">(
    "banks.export-package",
    {
      bankRevisionId: first.revision.id,
    },
  );
  expect(exported).toMatchObject({
    format: "agent-evaluation-harness/question-bank",
    version: 1,
    name: publish.name,
    questions: first.revision.questions,
    evaluator: {
      name: publish.evaluatorName,
      settings: first.evaluatorRevision.settings,
    },
    jevProfile: { name: profile.name, settings: profile.settings },
    source: {
      bankRevisionId: first.revision.id,
      evaluatorRevisionId: first.evaluatorRevision.id,
      jevProfileRevisionId: profile.id,
    },
  });
  const imported = await app.execute<"banks.publish">("banks.publish", {
    name: exported.name,
    questions: exported.questions,
    evaluatorName: exported.evaluator.name,
    evaluatorSettings: exported.evaluator.settings,
  });
  expect(imported.revision.questions).toEqual(first.revision.questions);
  expect(imported.evaluatorRevision.settings).toEqual(
    first.evaluatorRevision.settings,
  );
  await expect(
    app.execute<"banks.export-package">("banks.export-package", {
      bankRevisionId: first.revision.id,
      evaluatorRevisionId: imported.evaluatorRevision.id,
    }),
  ).rejects.toThrow(/different|another|belongs/i);
  expect(
    await app.execute<"banks.export">("banks.export", {
      bankRevisionId: first.revision.id,
    }),
  ).toEqual(first.revision);
});

it("uses the same answer contract for samples, calibration, saved-answer previews, and publication", async () => {
  const { app } = await setup();
  const integerQuestion = {
    ...question,
    expected: 49,
    answerFormat: {
      type: "scalar" as const,
      valueType: "integer" as const,
      nullable: false,
    },
  };
  const settings = {
    decimalPlaces: 0,
    calibrationExamples: [
      {
        id: "fractional",
        questionId: question.id,
        answer: 49.1,
        expectedStatus: "incorrect" as const,
      },
    ],
  };
  const first = await app.execute<"banks.publish">("banks.publish", {
    ...publish,
    questions: [integerQuestion],
    evaluatorSettings: { decimalPlaces: 0 },
  });
  const run = await app.execute<"runs.launch">("runs.launch", {
    bankRevisionId: first.revision.id,
    agent,
  });
  await app.waitForIdle();
  const sample = await app.execute<"banks.check-answer">("banks.check-answer", {
    question: integerQuestion,
    settings,
    answer: 49.1,
  });
  expect(sample).toMatchObject({
    status: "incorrect",
    details: { reason: "public_format" },
  });
  const calibration = await app.execute<"banks.calibrate-draft">(
    "banks.calibrate-draft",
    {
      questions: [integerQuestion],
      settings,
    },
  );
  expect(calibration).toMatchObject({ passed: 1, total: 1 });
  expect(calibration.results[0]?.actual).toEqual(sample);
  const preview = await app.execute<"banks.preview-draft">(
    "banks.preview-draft",
    {
      bankId: first.revision.bankId,
      questions: [integerQuestion],
      settings,
      runIds: [run.run.id],
    },
  );
  expect(preview.runs[0]?.rows[0]?.before).toEqual(sample);
  expect(preview.runs[0]?.rows[0]?.after).toEqual(sample);
  const published = await app.execute<"banks.publish">("banks.publish", {
    ...publish,
    bankId: first.revision.bankId,
    baseRevisionId: first.revision.id,
    baseEvaluatorRevisionId: first.evaluatorRevision.id,
    questions: [integerQuestion],
    evaluatorSettings: settings,
  });
  expect(published.evaluatorRevision.calibration?.results[0]?.actual).toEqual(
    sample,
  );
  await expect(
    app.execute<"banks.publish">("banks.publish", {
      ...publish,
      bankId: first.revision.bankId,
      baseRevisionId: published.revision.id,
      baseEvaluatorRevisionId: published.evaluatorRevision.id,
      questions: [integerQuestion],
      evaluatorSettings: {
        ...settings,
        calibrationExamples: [
          { ...settings.calibrationExamples[0]!, expectedStatus: "correct" },
        ],
      },
    }),
  ).rejects.toThrow(/calibration/i);
});
