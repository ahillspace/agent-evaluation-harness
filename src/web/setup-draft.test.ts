import { describe, expect, it } from "vitest";
import { initialSetup, createLaunch, roleSettings } from "./drafts.js";
import {
  decodeSetupDraft,
  encodeSetupDraft,
  restoreResearchSetup,
  filterQuestions,
  selectedQuestionIds,
  setupDraftKey,
} from "./setup-draft.js";
import { researchSchema } from "../contracts.js";

describe("durable setup draft", () => {
  it("scopes draft keys to a stable workspace identity and refuses an unscoped fallback", () => {
    expect(setupDraftKey("workspace-a")).not.toBe(setupDraftKey("workspace-b"));
    expect(setupDraftKey("workspace-a")).toBe(setupDraftKey("workspace-a"));
    expect(setupDraftKey(undefined)).toBeUndefined();
  });
  it("derives each role's auth source from the selected connection after reuse", () => {
    const draft = {
      ...initialSetup(),
      bankRevisionId: "bank",
      model: "luna",
      settings: '{"authSource":"local","maxTurns":12}',
      providerConnectionId: "target-key",
      providerConnectionProvider: "openai",
      judge: true,
      judgeModel: "luna",
      judgeSettings: '{"authSource":"connection"}',
    };
    const launch = createLaunch(draft);
    expect(
      launch.target?.kind === "managed" && launch.target.agent.settings,
    ).toMatchObject({ authSource: "connection", maxTurns: 12 });
    expect(launch.judge.agent?.settings.authSource).toBe("local");
    expect(
      roleSettings('{"authSource":"local"}', "research-key").authSource,
    ).toBe("connection");
    expect(roleSettings('{"authSource":"connection"}', "").authSource).toBe(
      "local",
    );
  });
  it("does not persist credentials pasted into advanced settings", () => {
    expect(() =>
      encodeSetupDraft(
        { ...initialSetup(), settings: '{"apiKey":"secret"}' },
        "agent",
        "",
      ),
    ).toThrow("credentials");
    expect(() =>
      encodeSetupDraft(
        { ...initialSetup(), researcherSettings: '{"password":"unfinished' },
        "research",
        "",
      ),
    ).toThrow("credentials");
  });
  it("round trips incomplete form text and role settings without unknown credential fields", () => {
    const draft = {
      ...initialSetup(),
      model: "luna",
      researcherModel: "research",
      settings: '{"unfinished":',
      questionSelection: "selected" as const,
      questionIds: [],
      password: "never-store",
    };
    const encoded = encodeSetupDraft(draft, "tools", "run:one");
    expect(encoded).not.toContain("never-store");
    expect(decodeSetupDraft(encoded)).toMatchObject({
      draft: {
        model: "luna",
        settings: '{"unfinished":',
        questionSelection: "selected",
        questionIds: [],
      },
      section: "tools",
      source: "run:one",
    });
  });
  it("rejects corrupt and unsupported snapshots", () => {
    expect(decodeSetupDraft("{")).toBeUndefined();
    expect(decodeSetupDraft('{"version":999,"draft":{}}')).toBeUndefined();
  });
  it("keeps none distinct from all and blocks an empty selection at launch", () => {
    const draft = {
      ...initialSetup(),
      bankRevisionId: "bank",
      model: "luna",
      questionSelection: "selected" as const,
    };
    expect(selectedQuestionIds(draft, [{ id: "q1" }])).toEqual([]);
    expect(() => createLaunch(draft)).toThrow("Select at least one question");
    expect(selectedQuestionIds(initialSetup(), [{ id: "q1" }])).toEqual(["q1"]);
  });
  it("restores complete research configuration without replacing the selected candidate", () => {
    const configuration = researchSchema.parse({
      baseline: createLaunch({
        ...initialSetup(),
        bankRevisionId: "b",
        model: "baseline",
      }),
      researcher: {
        harness: "codex",
        model: "luna",
        systemPrompt: "Investigate",
        settings: { maxTurns: 12 },
        tools: [],
        connections: [
          {
            connectionId: "r-auth",
            provider: "openai",
            settings: {},
            credentialFields: [],
          },
        ],
      },
      objective: "Improve",
      guidance: "Keep evidence",
      maxDurationMs: 420000,
      maxTotalTokens: 12345,
    });
    const restored = restoreResearchSetup(
      { ...initialSetup(), model: "candidate" },
      configuration,
    );
    expect(restored).toMatchObject({
      model: "candidate",
      research: true,
      researcherModel: "luna",
      researcherPrompt: "Investigate",
      researcherProviderConnectionId: "r-auth",
      maxMinutes: 7,
      maxTotalTokens: "12345",
      guidance: "Keep evidence",
    });
  });
  it("filters question text, identifiers, types, and tags independently", () => {
    const questions = [
      { id: "q1", text: "Revenue", expected: 1, tags: ["finance"] },
      { id: "q2", text: "Region", expected: "west", tags: ["geography"] },
    ];
    expect(filterQuestions(questions, "q1", "", "")).toEqual([questions[0]]);
    expect(filterQuestions(questions, "", "number", "finance")).toEqual([
      questions[0],
    ]);
    expect(filterQuestions(questions, "", "string", "finance")).toEqual([]);
  });
});
