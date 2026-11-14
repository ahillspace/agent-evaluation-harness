import { isDeepStrictEqual } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { agentSchema, judgeSchema, type RuntimePort } from "../contracts.js";
import { createApplication } from "./application.js";
import { Database } from "../storage/database.js";
import { buildJudgeEvidence } from "./judge-evidence.js";
import { observePass } from "./assessment-passes.js";
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
  expect(
    run.assessmentPasses!.find((pass) => pass.source === "llm")?.judgments[0]
      ?.explanation,
  ).toMatch(/Token budget/);
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

it.each(["original", "saved", "human"] as const)(
  "inspects %s LLM scores without parsing raw exchanges and preserves their complete export",
  async (kind) => {
    const marker = "RECORDED_LLM_EXCHANGE_" + "x".repeat(90_000);
    const invocation = {
      request: { prompt: marker + "_REQUEST_END" },
      response: { transcript: [{ text: marker + "_RESPONSE_END" }] },
      configuration: judge,
      provenance: { harness: "codex", model: "fixture" },
    };
    const { app, bank } = await setup(
      async () => ({ answer: 42, text: "42" }),
      async () => ({
        verdict: true,
        explanation: "Recorded verdict",
        invocation,
      }),
    );
    const launched = await app.execute("runs.launch", {
      bankRevisionId: bank.id,
      agent,
      judge,
    });
    await app.waitForIdle();
    const runId = launched.run.id;
    let passId = `original_llm_${runId}`;
    if (kind === "saved")
      passId = (
        await app.execute("runs.assess", {
          runId,
          name: "Saved LLM score",
          source: "llm",
          judge,
        })
      ).id;
    if (kind === "human")
      passId = (
        await app.execute("runs.review-assessment", {
          runId,
          parentPassId: passId,
          name: "Reviewed LLM score",
          overrides: [
            {
              resultId: launched.results[0]!.id,
              verdict: true,
              note: "Retain evidence",
            },
          ],
        })
      ).id;
    const view = await app.execute("runs.get", { runId });
    const observed = view.assessmentPasses!.find((pass) => pass.id === passId)!;
    const input = {
      runId,
      passId,
      expectedObservationRevision: observed.observationRevision,
    };
    const originalParse = JSON.parse;
    const parsedRaw: string[] = [];
    const parse = vi
      .spyOn(JSON, "parse")
      .mockImplementation((text, reviver) => {
        if (text.includes("RECORDED_LLM_EXCHANGE_")) parsedRaw.push(text);
        return originalParse(text, reviver);
      });
    let inspection;
    try {
      inspection = await app.execute("runs.assessment", input);
    } finally {
      parse.mockRestore();
    }
    expect(parsedRaw).toHaveLength(0);
    expect(inspection.observationRevision).toBe(observed.observationRevision);
    expect(inspection.judgments[0]).toHaveProperty("hasRecordedExchange", true);
    expect(inspection.judgments[0]).not.toHaveProperty("request");
    expect(inspection.judgments[0]).not.toHaveProperty("response");
    expect(inspection.configuration.judge).toEqual(judge);
    const exported = await app.execute("runs.export-assessment", input);
    expect(observePass(exported).observationRevision).toBe(
      observed.observationRevision,
    );
    expect(exported.judgments[0]?.response).toEqual(invocation);
    expect(JSON.stringify(exported)).toContain("_REQUEST_END");
    expect(JSON.stringify(exported)).toContain("_RESPONSE_END");
    expect(exported.judgments[0]).not.toHaveProperty("hasRecordedExchange");
    expect(observed.judgments[0]).not.toHaveProperty("hasRecordedExchange");
  },
);

it("offers legacy unbound null and false exchanges without adding inspection metadata to their canonical revision", async () => {
  const { app, bank, directory } = await setup(
    async () => ({ answer: 42, text: "42" }),
    async () => ({ verdict: true }),
  );
  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
  });
  await app.waitForIdle();
  const original = await app.execute("runs.export-assessment", {
    runId: launched.run.id,
    passId: `original_deterministic_${launched.run.id}`,
  });
  const db = new Database(join(directory, "workspace.sqlite"));
  db.insert(
    "assessmentPass",
    {
      ...original,
      id: "legacy-unbound-exchange",
      source: "human",
      judgments: [
        {
          resultId: launched.results[0]!.id,
          status: "unjudged",
          explanation: "Historical exchange",
          request: null,
          response: false,
        },
      ],
    },
    true,
  );
  db.close();
  const observed = (
    await app.execute("runs.observe", { runId: launched.run.id })
  ).assessmentPasses!.find((pass) => pass.id === "legacy-unbound-exchange")!;
  const input = {
    runId: launched.run.id,
    passId: observed.id,
    expectedObservationRevision: observed.observationRevision,
  };
  const inspection = await app.execute("runs.assessment", input);
  expect(inspection.judgments[0]).toHaveProperty("hasRecordedExchange", true);
  expect(inspection.judgments[0]).not.toHaveProperty("request");
  expect(inspection.judgments[0]).not.toHaveProperty("response");
  const full = await app.execute("runs.export-assessment", input);
  expect(full.judgments[0]).toMatchObject({ request: null, response: false });
  expect(observePass(full).observationRevision).toBe(
    inspection.observationRevision,
  );
  expect(observed.judgments[0]).not.toHaveProperty("hasRecordedExchange");
});

it("inspects an unsnapshotted automatic abstention using its canonical observation and compact raw binding", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const marker = "UNSNAPSHOTTED_RAW_EXCHANGE";
  const { app } = await setup(
    async (input) => {
      if (input.question.id === "q2") {
        entered();
        await held;
      }
      return { answer: 42, text: "42" };
    },
    async () => ({
      verdict: null,
      invocation: {
        request: { marker },
        response: { marker },
        configuration: judge,
        provenance: { harness: "codex", model: "fixture" },
      },
    }),
  );
  const bank = await app.execute("banks.create", {
    name: "Live automatic",
    questions: [
      { id: "q1", text: "One?", expected: 42 },
      { id: "q2", text: "Two?", expected: 42 },
    ],
  });
  const launched = await app.execute("runs.launch", {
    bankRevisionId: bank.id,
    agent,
    judge,
    limits: { concurrency: 1 },
  });
  try {
    await started;
    const runId = launched.run.id,
      passId = `original_llm_${runId}`;
    const observed = (
      await app.execute("runs.observe", { runId })
    ).assessmentPasses!.find((pass) => pass.id === passId)!;
    const input = {
      runId,
      passId,
      expectedObservationRevision: observed.observationRevision,
    };
    const full = await app.execute("runs.export-assessment", input);
    expect(observePass(full).observationRevision).toBe(
      observed.observationRevision,
    );
    const originalParse = JSON.parse;
    const rawBodies: string[] = [];
    const parse = vi
      .spyOn(JSON, "parse")
      .mockImplementation((text, reviver) => {
        if (text.includes(marker)) rawBodies.push(text);
        return originalParse(text, reviver);
      });
    try {
      const inspection = await app.execute("runs.assessment", input);
      expect(inspection.observationRevision).toBe(observed.observationRevision);
      expect(inspection.judgments[0]).toHaveProperty(
        "hasRecordedExchange",
        true,
      );
      expect(rawBodies).toHaveLength(0);
    } finally {
      parse.mockRestore();
    }
  } finally {
    release();
    await app.waitForIdle();
  }
});

it.each([false, null, undefined])(
  "preserves historical automatic raw response %j through running and interrupted inspection, export, and retry",
  async (response) => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let directory = "",
      seeded = false;
    const call = vi
      .fn<RuntimePort["judge"]>()
      .mockImplementation(async ({ evidence }) => {
        if (!seeded) {
          seeded = true;
          const db = new Database(join(directory, "workspace.sqlite"));
          db.insert(
            "assessment",
            {
              id: "historical-raw",
              runId: evidence.runId,
              resultId: evidence.resultId,
              attemptId: evidence.attemptId,
              deterministic: {
                status: "correct",
                explanation: "Historical correct",
              },
              judgeAdmitted: true,
              judgeRequest: null,
              ...(response !== undefined ? { judgeResponse: response } : {}),
            },
            true,
          );
          db.close();
        }
        return { verdict: true };
      });
    const fixture = await setup(async (input) => {
      if (input.question.id === "q2") {
        entered();
        await held;
      }
      return { answer: 42, text: "42" };
    }, call);
    directory = fixture.directory;
    const { app } = fixture;
    const bank = await app.execute("banks.create", {
      name: "Historical raw primitives",
      questions: [
        { id: "q1", text: "One?", expected: 42 },
        { id: "q2", text: "Held?", expected: 42 },
      ],
    });
    const launch = await app.execute("runs.launch", {
      bankRevisionId: bank.id,
      agent,
      judge,
      limits: { concurrency: 1 },
    });
    try {
      await started;
      const runId = launch.run.id,
        passId = `original_llm_${runId}`;
      for (const interrupted of [false, true]) {
        if (interrupted) {
          // Historical stopped header, with the second slot held so no family is sealed.
          const db = new Database(join(directory, "workspace.sqlite"));
          db.update("run", {
            ...db.require("run", runId),
            status: "halted",
            intent: "halt",
          });
          db.close();
        }
        const observed = (
          await app.execute("runs.observe", { runId })
        ).assessmentPasses!.find((pass) => pass.id === passId)!;
        expect(observed.status).toBe(interrupted ? "interrupted" : "running");
        const input = {
          runId,
          passId,
          expectedObservationRevision: observed.observationRevision,
        };
        const originalParse = JSON.parse;
        const parsedRaw: string[] = [];
        const parse = vi
          .spyOn(JSON, "parse")
          .mockImplementation((text, reviver) => {
            if (
              text.includes('"judgeRequest"') ||
              text.includes('"judgeResponse"')
            )
              parsedRaw.push(text);
            return originalParse(text, reviver);
          });
        let inspection;
        try {
          inspection = await app.execute("runs.assessment", input);
        } finally {
          parse.mockRestore();
        }
        expect(parsedRaw).toHaveLength(0);
        expect(inspection.judgments[0]).toHaveProperty(
          "hasRecordedExchange",
          true,
        );
        const full = await app.execute("runs.export-assessment", input);
        expect(full.judgments[0]).toHaveProperty("request", null);
        if (response === undefined)
          expect(full.judgments[0]).not.toHaveProperty("response");
        else expect(full.judgments[0]).toHaveProperty("response", response);
        expect(observePass(full).observationRevision).toBe(
          observed.observationRevision,
        );
        expect(inspection.observationRevision).toBe(
          observed.observationRevision,
        );
        if (interrupted)
          expect(full.retryableJudgments).toBe(response === undefined ? 1 : 0);
      }
      if (response === undefined) {
        await app.execute("runs.retry-assessment", { runId, passId });
        expect(call).toHaveBeenCalledTimes(2);
      } else {
        await expect(
          app.execute("runs.retry-assessment", { runId, passId }),
        ).rejects.toMatchObject({ code: "invalid_state" });
        expect(call).toHaveBeenCalledTimes(1);
      }
    } finally {
      release();
      await app.waitForIdle();
    }
  },
);

it.each([false, null, undefined])(
  "recovers a running saved score with response %j according to recorded presence",
  async (response) => {
    const judgeCall = vi
      .fn<RuntimePort["judge"]>()
      .mockResolvedValue({ verdict: true });
    const { app, bank, directory } = await setup(
      async () => ({ answer: 42, text: "42" }),
      judgeCall,
    );
    const launch = await app.execute("runs.launch", {
      bankRevisionId: bank.id,
      agent,
    });
    await app.waitForIdle();
    const parent = await app.execute("runs.export-assessment", {
      runId: launch.run.id,
      passId: `original_deterministic_${launch.run.id}`,
    });
    await app.close();
    const db = new Database(join(directory, "workspace.sqlite"));
    db.insert("assessmentPass", {
      ...parent,
      id: "interrupted-raw",
      source: "llm",
      status: "running",
      configuration: { ...parent.configuration, judge },
      judgments: parent.judgments.map((j) => ({
        ...j,
        status: "unjudged",
        request: null,
        ...(response !== undefined ? { response } : {}),
      })),
    });
    db.close();
    const reopened = await createApplication({
      dataDirectory: directory,
      runtime: {
        ...targetFixture,
        execute: async () => {
          throw Error("Unexpected target");
        },
        judge: judgeCall,
        resolveAgent: async (a) => a,
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
        testConnection: async () => ({ ok: true, message: "fixture" }),
        researcher: async () => {
          throw Error("unused");
        },
      },
    });
    cleanup.push(() => reopened.close());
    const full = await reopened.execute("runs.export-assessment", {
      runId: launch.run.id,
      passId: "interrupted-raw",
    });
    expect(full.judgments[0]?.status).toBe(
      response === undefined ? "error" : "unjudged",
    );
    expect(full.retryableJudgments).toBe(response === undefined ? 1 : 0);
    if (response !== undefined)
      expect(full.judgments[0]).toHaveProperty("response", response);
    expect(judgeCall).not.toHaveBeenCalled();
  },
);

it.each([false, null])(
  "retries only the failed judgment beside a recorded %j abstention",
  async (response) => {
    const call = vi
      .fn<RuntimePort["judge"]>()
      .mockResolvedValue({ verdict: true });
    const { app, directory } = await setup(
      async () => ({ answer: 42, text: "42" }),
      call,
    );
    const bank = await app.execute("banks.create", {
      name: "Mixed retry",
      questions: [
        { id: "q1", text: "One?", expected: 42 },
        { id: "q2", text: "Two?", expected: 42 },
      ],
    });
    const launch = await app.execute("runs.launch", {
      bankRevisionId: bank.id,
      agent,
    });
    await app.waitForIdle();
    const parent = await app.execute("runs.export-assessment", {
      runId: launch.run.id,
      passId: `original_deterministic_${launch.run.id}`,
    });
    const db = new Database(join(directory, "workspace.sqlite"));
    db.insert(
      "assessmentPass",
      {
        ...parent,
        id: "mixed-retry",
        source: "llm",
        status: "interrupted",
        configuration: { ...parent.configuration, judge },
        judgments: parent.judgments.map((j, i) => ({
          ...j,
          status: i === 0 ? "unjudged" : "error",
          ...(i === 0 ? { request: null, response } : {}),
        })),
      },
      true,
    );
    db.close();
    const retried = await app.execute("runs.retry-assessment", {
      runId: launch.run.id,
      passId: "mixed-retry",
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]![0].evidence.question.id).toBe("q2");
    expect(retried.judgments[0]).toMatchObject({
      status: "unjudged",
      request: null,
      response,
    });
    expect(retried.judgments[1]?.status).toBe("correct");
  },
);

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
  const savedOriginal = await app.execute("runs.export-assessment", {
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
