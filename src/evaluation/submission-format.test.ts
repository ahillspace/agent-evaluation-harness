import { expect, it } from "vitest";
import {
  evaluatorSettingsSchema,
  type AnswerFormat,
  type Json,
} from "../contracts.js";
import { grade } from "./scoring.js";

const settings = (value: unknown = {}) => evaluatorSettingsSchema.parse(value);
const scalar: AnswerFormat = {
  type: "scalar",
  valueType: "string",
  nullable: false,
};
it("rejects a public string format mismatch while keeping ordinary comparison behavior unchanged", async () => {
  expect((await grade("42", 42, settings())).status).toBe("correct");
  expect(await grade("42", 42, settings(), scalar)).toMatchObject({
    status: "incorrect",
    details: { reason: "public_format" },
  });
});
it("applies extraction and singleton policies before validating the public format", async () => {
  expect(
    (
      await grade(
        "42",
        { result: ["42"] },
        settings({ answerPath: "/result", unwrapSingleton: true }),
        scalar,
      )
    ).status,
  ).toBe("correct");
  expect(
    (
      await grade(
        "42",
        { result: ["42", "42"] },
        settings({ answerPath: "/result", unwrapSingleton: true }),
        scalar,
      )
    ).status,
  ).toBe("incorrect");
});
it.each([" 42.00 ", "4.2e1", 42])(
  "preserves accepted exact numeric representations %j",
  async (answer) => {
    expect(
      (
        await grade(42, answer, settings(), {
          type: "scalar",
          valueType: "integer",
          nullable: false,
        })
      ).status,
    ).toBe("correct");
  },
);
it("validates typed tables after JSON row decoding and reviewed aliases", async () => {
  const expected: Json = {
    type: "table",
    columns: [{ name: "Revenue", type: "decimal" }],
    rows: [{ Revenue: 12.345 }],
  };
  const format: AnswerFormat = {
    type: "table",
    columns: [{ name: "Revenue", type: "decimal", nullable: false }],
  };
  const policy = settings({
    columnAliases: { Revenue: ["SUM(Revenue)"] },
    columnRules: { Revenue: { decimalPlaces: 2 } },
  });
  const answer = JSON.stringify([{ "SUM(Revenue)": " 12.35 " }]);
  expect((await grade(expected, answer, policy, format)).status).toBe(
    "correct",
  );
  expect(
    (
      await grade(
        expected,
        JSON.stringify([{ "SUM(Revenue)": "12.36" }]),
        policy,
        format,
      )
    ).status,
  ).toBe("incorrect");
});
it("preserves explicitly configured calendar date comparison", async () => {
  const expected: Json = {
    type: "table",
    columns: [{ name: "Date", type: "date" }],
    rows: [{ Date: "2026-01-02" }],
  };
  const format: AnswerFormat = {
    type: "table",
    columns: [{ name: "Date", type: "date", nullable: false }],
  };
  expect(
    (
      await grade(
        expected,
        [{ Date: "2026-01-02T18:00:00Z" }],
        settings({
          columnRules: { Date: { dateComparison: "calendar_date" } },
        }),
        format,
      )
    ).status,
  ).toBe("correct");
});
it("checks explicit nullability even when a custom evaluator returns true", async () => {
  expect(
    (
      await grade(
        "42",
        null,
        settings({
          mode: "custom",
          code: "return {verdict:true, explanation:'Accepted'};",
        }),
        scalar,
      )
    ).status,
  ).toBe("incorrect");
});
