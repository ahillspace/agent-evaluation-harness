import { expect, it } from "vitest";
import {
  evaluatorSettingsSchema,
  judgeSchema,
  type FrozenJevJudge,
} from "../contracts.js";
import { validateTargetEvidence } from "./evidence-requirements.js";

it("rejects unsupported effective per-question checks before admission", () => {
  expect(() =>
    validateTargetEvidence({
      observation: "answer-only",
      questionIds: ["q"],
      evaluator: evaluatorSettingsSchema.parse({
        questionOverrides: { q: { mode: "custom", code: "return false;" } },
      }),
      judge: judgeSchema.parse({}),
    }),
  ).toThrow(/evidence/i);
  expect(() =>
    validateTargetEvidence({
      observation: "answer-only",
      questionIds: ["q"],
      evaluator: evaluatorSettingsSchema.parse({}),
      judge: judgeSchema.parse({}),
    }),
  ).not.toThrow();
});
it("rejects free-form optional judging without an answer evidence declaration", () => {
  const judge = judgeSchema.parse({
    enabled: true,
    agent: { harness: "codex", model: "fixture" },
    instructions: "Require a query tool call.",
  });
  expect(() =>
    validateTargetEvidence({
      observation: "answer-only",
      questionIds: ["q"],
      evaluator: evaluatorSettingsSchema.parse({}),
      judge,
    }),
  ).toThrow(/judge/i);
  expect(() =>
    validateTargetEvidence({
      observation: "answer-only",
      questionIds: ["q"],
      evaluator: evaluatorSettingsSchema.parse({}),
      judge: { ...judge, evidenceRequirement: "answer" },
    }),
  ).not.toThrow();
});
it("rejects incompatible Jev profile evidence", () => {
  const jevJudge = {
    profile: { settings: { evidenceRequirement: "internal-activity" } },
  } as FrozenJevJudge;
  expect(() =>
    validateTargetEvidence({
      observation: "answer-only",
      questionIds: ["q"],
      evaluator: evaluatorSettingsSchema.parse({}),
      judge: judgeSchema.parse({}),
      jevJudge,
    }),
  ).toThrow(/Jev/);
});
