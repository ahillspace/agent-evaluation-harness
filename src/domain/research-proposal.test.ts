import { describe, expect, it } from "vitest";
import { agentSchema, researchSchema } from "../contracts.js";
import { validateResearchProposal } from "./research-proposal.js";

describe("research proposal boundaries", () => {
  const baseline = agentSchema.parse({
    harness: "codex",
    model: "first",
    settings: { maxTurns: 5 },
    tools: ["query"],
  });
  const configuration = researchSchema.parse({
    baseline: { bankRevisionId: "bank", agent: baseline },
    researcher: baseline,
    objective: "Improve accuracy",
    allowedChanges: ["model", "systemPrompt", "settings", "tools"],
    searchSpace: {
      models: ["first", "second"],
      tools: ["query"],
      settings: { maxTurns: [5, 10] },
      maxSystemPromptLength: 1000,
    },
  });
  it("accepts bounded changes while preserving immutable harness and connections", () => {
    expect(
      validateResearchProposal(configuration, baseline, {
        ...baseline,
        model: "second",
        settings: { maxTurns: 10 },
      }).model,
    ).toBe("second");
    expect(() =>
      validateResearchProposal(configuration, baseline, {
        ...baseline,
        harness: "opencode",
      }),
    ).toThrow(/harness/);
  });
  it("rejects undeclared values and hidden setting additions", () => {
    expect(() =>
      validateResearchProposal(configuration, baseline, {
        ...baseline,
        tools: ["admin"],
      }),
    ).toThrow(/tools/);
    expect(() =>
      validateResearchProposal(configuration, baseline, {
        ...baseline,
        model: "third",
      }),
    ).toThrow(/model/);
    expect(() =>
      validateResearchProposal(configuration, baseline, {
        ...baseline,
        settings: { maxTurns: 5, temperature: 2 },
      }),
    ).toThrow(/temperature/);
    expect(() =>
      validateResearchProposal(configuration, baseline, {
        ...baseline,
        systemPrompt: "x".repeat(1001),
      }),
    ).toThrow(/prompt/);
  });
});
