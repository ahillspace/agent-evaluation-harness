import { expect, it } from "vitest";
import { agentSchema, jevJudgeSelectionSchema } from "../contracts.js";

it("trims outer model whitespace and rejects a whitespace-only model", () => {
  expect(
    agentSchema.parse({
      harness: "opencode",
      model: "  openai/gpt-test  ",
    }).model,
  ).toBe("openai/gpt-test");
  expect(() =>
    agentSchema.parse({ harness: "opencode", model: "   " }),
  ).toThrow();
});

it("trims outer pinned Jev model whitespace before validating its format", () => {
  expect(
    jevJudgeSelectionSchema.parse({
      connectionId: "jev-connection",
      model: "  jev-1.13.0  ",
    }).model,
  ).toBe("jev-1.13.0");
});
