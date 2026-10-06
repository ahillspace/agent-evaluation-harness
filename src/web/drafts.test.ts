import { managedAgent } from "../contracts/targets.js";
import { describe, expect, it } from "vitest";
import {
  parseQuestions,
  initialSetup,
  createLaunch,
  restoreSetup,
  replaceExpectedAnswer,
} from "./drafts.js";
import { launchSchema, type RunRecord } from "../contracts.js";

describe("form submission boundaries", () => {
  it("refreshes a derived scalar format when its reference type changes", () => {
    const updated = replaceExpectedAnswer(
      {
        id: "q",
        text: "Value?",
        tags: [],
        expected: { type: "numeric", value: "12.3" },
        answerFormat: { type: "scalar", valueType: "decimal", nullable: true },
      },
      { type: "string", value: "A" },
    );
    expect(updated.answerFormat).toBeUndefined();
  });
  it("refreshes derived table formats when editing reference columns", () => {
    const question = {
      id: "q",
      text: "Totals?",
      tags: [],
      expected: {
        type: "table",
        columns: [{ name: "old", type: "integer" }],
        rows: [{ old: 1 }],
      },
      answerFormat: {
        type: "table" as const,
        columns: [{ name: "old", type: "integer" as const, nullable: false }],
      },
    };
    const updated = replaceExpectedAnswer(question, {
      type: "table",
      columns: [{ name: "new", type: "integer" }],
      rows: [{ new: 1 }],
    });
    expect(updated.answerFormat).toBeUndefined();
    expect(question.answerFormat.columns[0]?.name).toBe("old");
    const authored = { ...question, expected: [{ old: 1 }] };
    expect(replaceExpectedAnswer(authored, [{ old: 2 }]).answerFormat).toEqual(
      authored.answerFormat,
    );
  });
  it("selects Jev independently and retains its frozen profile on reuse", () => {
    const draft = {
      ...initialSetup(),
      bankRevisionId: "b1",
      model: "target",
      jevEnabled: true,
      jevSelection: {
        connectionId: "j1",
        model: "jev-1.13.0",
        profileRevisionId: "p1",
      },
    };
    const launch = createLaunch(draft);
    expect(launch.judge.enabled).toBe(false);
    expect(
      createLaunch({ ...draft, judge: true, judgeModel: "llm-judge" }).judge
        .enabled,
    ).toBe(true);
    expect(launch.jevJudge).toEqual(draft.jevSelection);
    const run = {
      name: "Saved",
      manifest: {
        ...launch,
        bank: { id: "b1" },
        evaluator: { id: "e1" },
        questions: [{ id: "q1" }],
        jevJudge: {
          connection: { connectionId: "j1" },
          model: "jev-1.13.0",
          profile: { id: "p1" },
        },
      },
    } as unknown as RunRecord;
    expect(createLaunch(restoreSetup(run)).jevJudge).toEqual(launch.jevJudge);
    expect(
      createLaunch({ ...draft, jevEnabled: false }).jevJudge,
    ).toBeUndefined();
  });
  it("accepts published JSON bank exports as import input", () => {
    expect(
      parseQuestions(
        '{"questions":[{"id":"q1","text":"Revenue?","expected":12}]}',
      ),
    ).toEqual([{ id: "q1", text: "Revenue?", expected: 12, tags: [] }]);
  });
  it("imports quoted CSV fields without losing commas", () => {
    expect(
      parseQuestions('id,question,expected\nq1,"Revenue, net?",12')[0],
    ).toMatchObject({ text: "Revenue, net?", expected: 12 });
  });
  it("submits one run configuration and a repetition count", () => {
    const draft = {
      ...initialSetup(),
      bankRevisionId: "bankrev_1",
      model: "chosen-model",
      repetitions: 3,
    };
    const launch = createLaunch(draft);
    expect(launch.repetitions).toBe(3);
    expect(managedAgent(launch.target).model).toBe("chosen-model");
    expect(launch).not.toHaveProperty("experiments");
    expect(managedAgent(launch.target)).not.toHaveProperty("expected");
  });
  it("rejects malformed advanced settings before a command is sent", () => {
    expect(() => createLaunch({ ...initialSetup(), settings: "[]" })).toThrow(
      "JSON object",
    );
  });
  it("keeps judge authentication and model settings independent of the target", () => {
    const input = createLaunch({
      ...initialSetup(),
      bankRevisionId: "b1",
      model: "target-model",
      judge: true,
      judgeModel: "judge-model",
      judgeHarness: "opencode",
      judgeProviderConnectionId: "judge-key",
      judgeProviderConnectionProvider: "openai",
      judgeSettings: '{"temperature":0.1}',
    });
    expect(managedAgent(input.target).connections).toEqual([]);
    expect(input.judge.agent?.connections[0]?.connectionId).toBe("judge-key");
    expect(input.judge.agent?.settings).toEqual({
      temperature: 0.1,
      authSource: "connection",
    });
  });
  it("reuses all saved agent settings, connection bindings, and output limits", () => {
    const launch = launchSchema.parse({
      bankRevisionId: "b1",
      agent: {
        harness: "codex",
        model: "configured",
        settings: { maxTurns: 12, reasoningEffort: "high" },
        tools: ["read"],
        connections: [
          {
            connectionId: "c1",
            provider: "tableau",
            settings: { server: "https://tableau.example" },
            credentialFields: ["patValue"],
          },
        ],
      },
      limits: { maxOutputBytes: 456789 },
      judge: {
        enabled: true,
        agent: {
          harness: "opencode",
          model: "judge",
          settings: { temperature: 0.2 },
        },
      },
    });
    const run = {
      name: "Saved",
      manifest: {
        ...launch,
        bank: { id: "b1" },
        evaluator: { id: "e1" },
        questions: [{ id: "q1" }],
      },
    } as unknown as RunRecord;
    const restored = createLaunch(restoreSetup(run));
    expect(managedAgent(restored.target)).toEqual({
      ...managedAgent(launch.target),
      settings: {
        ...managedAgent(launch.target).settings,
        authSource: "local",
      },
    });
    expect(restored.limits).toEqual(launch.limits);
    expect(restored.judge).toEqual({
      ...launch.judge,
      agent: {
        ...launch.judge.agent,
        settings: { ...launch.judge.agent?.settings, authSource: "local" },
      },
    });
  });
});

it("restores an external blueprint without parsing hidden managed settings", () => {
  const target = {
    kind: "external" as const,
    adapterId: "http",
    adapterVersion: 1,
    name: "Endpoint",
    configuration: { endpoint: "https://example.com/answer" },
  };
  const input = launchSchema.parse({
    bankRevisionId: "b1",
    target,
    questionIds: ["q1"],
  });
  const restored = restoreSetup({
    id: "blueprint",
    name: "Saved endpoint",
    createdAt: "2026-10-04",
    target,
    repetitions: input.repetitions,
    limits: input.limits,
    judge: input.judge,
  });
  restored.bankRevisionId = "b1";
  restored.settings = "invalid hidden JSON";
  expect(createLaunch(restored).target).toEqual(target);
  expect(createLaunch(restored).limits.timeoutMs).toBe(120000);
  expect(restored.research).toBe(false);
});
