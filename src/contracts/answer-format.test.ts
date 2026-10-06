import { expect, it } from "vitest";
import { answerFormatSchema } from "../contracts.js";
import { parseDecimal } from "../evaluation/decimal.js";
import {
  answerFormatJsonSchema,
  deriveAnswerFormat,
  validateSubmittedAnswer,
} from "./answer-format.js";

const columns = [
  { name: "billing_country", type: "string", nullable: false },
  { name: "COUNT(*)", type: "integer", nullable: false },
];
it("uses the grader decimal exponent bounds in public validation and JSON schema", () => {
  const format = answerFormatSchema.parse({
    type: "scalar",
    valueType: "decimal",
    nullable: false,
  });
  const schema = answerFormatJsonSchema(format) as {
    anyOf: Array<{ pattern?: string }>;
  };
  const pattern = new RegExp(
    schema.anyOf.find((item) => item.pattern)!.pattern!,
  );
  for (const value of ["1e1000", "1e-1000", "1e+0001000", "1e-0001000"])
    expect([
      validateSubmittedAnswer(format, value).ok,
      pattern.test(value),
      parseDecimal(value) !== undefined,
    ]).toEqual([true, true, true]);
  for (const value of ["1e1001", "1e-1001", "1e999999", "1e-0001001"])
    expect([
      validateSubmittedAnswer(format, value).ok,
      pattern.test(value),
      parseDecimal(value) !== undefined,
    ]).toEqual([false, false, false]);
});
it("derives only declared table structure, excluding values, cardinality, ordering and extra metadata", () => {
  const format = deriveAnswerFormat({
    type: "table",
    columns: columns.map((column) => ({ ...column, example: "PRIVATE_VALUE" })),
    rows: [{ billing_country: "PRIVATE_COUNTRY", "COUNT(*)": 91 }],
    ordered: true,
    order_by: ["COUNT(*)"],
  });
  expect(format).toEqual({ type: "table", columns });
  expect(JSON.stringify(format)).not.toMatch(/PRIVATE|order|rows|91/);
  expect(deriveAnswerFormat({ type: "empty_table" })).toEqual({
    type: "list",
    itemType: "json",
    nullable: true,
  });
  expect(deriveAnswerFormat({ secret_value_key: 42 })).toBeUndefined();
});
it("preserves explicit null restrictions when extracting and validating structure", () => {
  const expected = {
    type: "table",
    columns: [{ name: "state", type: "string", nullable: false }],
    rows: [{ state: "CA" }],
  };
  const format = deriveAnswerFormat(expected)!;
  if (format.type !== "table") throw new Error("Expected table format.");
  expect(validateSubmittedAnswer(format, [{ state: null }])).toMatchObject({
    ok: false,
  });
  expect(expected.columns[0]?.nullable).toBe(false);
  expect(
    validateSubmittedAnswer(
      {
        ...format,
        columns: format.columns.map((column) => ({
          ...column,
          nullable: true,
        })),
      },
      [{ state: null }],
    ),
  ).toEqual({ ok: true });
});
it("generates a public schema and rejects incorrect keys before recording an answer", () => {
  const format = answerFormatSchema.parse({ type: "table", columns });
  expect(answerFormatJsonSchema(format)).toMatchObject({
    type: "array",
    items: {
      type: "object",
      required: ["billing_country", "COUNT(*)"],
      additionalProperties: false,
    },
  });
  expect(
    validateSubmittedAnswer(format, [
      { billing_country: "USA", "COUNT(*)": 91 },
    ]),
  ).toEqual({ ok: true });
  expect(
    validateSubmittedAnswer(format, [
      { country: "USA", number_of_invoices: 91 },
    ]),
  ).toMatchObject({ ok: false });
  expect(
    validateSubmittedAnswer(format, [
      { billing_country: "USA", "COUNT(*)": "9007199254740993" },
    ]),
  ).toEqual({ ok: true });
  expect(
    validateSubmittedAnswer(format, [
      { billing_country: "USA", "COUNT(*)": 1.5 },
    ]),
  ).toMatchObject({ ok: false });
  expect(validateSubmittedAnswer(format, [])).toEqual({ ok: true });
});
it("validates nullable and date metadata and rejects ambiguous column declarations", () => {
  expect(() =>
    answerFormatSchema.parse({
      type: "table",
      columns: [columns[0], columns[0]],
    }),
  ).toThrow();
  expect(() =>
    deriveAnswerFormat({
      type: "table",
      columns: [{ name: "secret", type: "arbitrary" }],
      rows: [],
    }),
  ).toThrow();
  const format = answerFormatSchema.parse({
    type: "table",
    columns: [{ name: "day", type: "date", nullable: true }],
  });
  expect(
    validateSubmittedAnswer(format, [{ day: null }, { day: "2026-10-03" }]),
  ).toEqual({ ok: true });
  expect(
    validateSubmittedAnswer(format, [{ day: "2026-02-30" }]),
  ).toMatchObject({ ok: false });
});

it("advertises and validates up to 10000 collection items without changing values", () => {
  for (const format of [
    answerFormatSchema.parse({
      type: "list",
      itemType: "string",
      nullable: false,
    }),
    answerFormatSchema.parse({
      type: "table",
      columns: [{ name: "name", type: "string", nullable: false }],
    }),
  ]) {
    const answer = Array.from({ length: 10000 }, (_, i) =>
      format.type === "list" ? String(i) : { name: String(i) },
    );
    expect(answerFormatJsonSchema(format)).toMatchObject({ maxItems: 10000 });
    expect(validateSubmittedAnswer(format, answer).ok).toBe(true);
    expect(validateSubmittedAnswer(format, [...answer, answer[0]!]).ok).toBe(
      false,
    );
  }
});
