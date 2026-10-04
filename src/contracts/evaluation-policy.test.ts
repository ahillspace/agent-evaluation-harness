import { describe, expect, it } from "vitest";
import { evaluatorSettingsSchema, judgeVerdictSchema } from "../contracts.js";
import {
  deriveAnswerFormat,
  validateSubmittedAnswer,
} from "./answer-format.js";

describe("explicit evaluation contracts", () => {
  it("accepts scoped comparison policies and calibration examples", () => {
    const settings = evaluatorSettingsSchema.parse({
      unwrapSingleton: true,
      answerPath: "/result/items",
      columnRules: {
        amount: { decimalPlaces: 2 },
        hired: { dateComparison: "calendar_date" },
      },
      calibrationExamples: [
        {
          id: "positive",
          questionId: "names",
          answer: ["Acme"],
          expectedStatus: "correct",
        },
      ],
    });
    expect(settings.columnRules?.amount?.decimalPlaces).toBe(2);
    expect(settings.calibrationExamples).toHaveLength(1);
  });
  it("rejects unexplained exclusions and unsafe ranking declarations", () => {
    expect(
      evaluatorSettingsSchema.safeParse({
        referenceDisposition: "needs_review",
      }).success,
    ).toBe(false);
    expect(
      evaluatorSettingsSchema.safeParse({
        topK: {
          count: 10,
          orderBy: [{ column: "score", direction: "desc" }],
          referenceComplete: false,
        },
      }).success,
    ).toBe(false);
    expect(
      evaluatorSettingsSchema.safeParse({ decimalPlaces: -1 }).success,
    ).toBe(false);
  });
  it("publishes scalar structure without reference values", () => {
    const format = deriveAnswerFormat({
      type: "string",
      value: "private reference",
    });
    expect(format).toEqual({
      type: "scalar",
      valueType: "string",
      nullable: true,
    });
    expect(JSON.stringify(format)).not.toContain("private reference");
    expect(validateSubmittedAnswer(format!, "other value").ok).toBe(true);
    expect(validateSubmittedAnswer(format!, ["other value"]).ok).toBe(false);
  });
  it("does not disclose empty or null outcomes in derived formats", () => {
    const format = deriveAnswerFormat({ type: "empty_table" });
    expect(format).toEqual({ type: "list", itemType: "json", nullable: true });
    expect(validateSubmittedAnswer(format!, [{ name: "nonempty" }]).ok).toBe(
      true,
    );
    expect(validateSubmittedAnswer(format!, "").ok).toBe(false);
    expect(deriveAnswerFormat({ type: "null_scalar" })).toBeUndefined();
  });
  it("preserves an independent judge's explicit abstention", () => {
    expect(
      judgeVerdictSchema.parse({
        verdict: null,
        explanation: "Reference conflicts with the evidence.",
      }).verdict,
    ).toBeNull();
  });
});
