import {
  answerFormatSchema,
  type AnswerFormat,
  type TableAnswerFormat,
  type Json,
} from "../contracts.js";
import { temporalValue } from "./temporal.js";
import { decimalStringPattern, parseDecimal } from "./numeric.js";

const object = (value: Json): value is Record<string, Json> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Derive structure only from explicit typed column declarations, never answer rows. */
export function deriveAnswerFormat(expected: Json): AnswerFormat | undefined {
  if (!object(expected)) return undefined;
  if (expected.type === "string")
    return { type: "scalar", valueType: "string", nullable: true };
  if (expected.type === "numeric")
    return {
      type: "scalar",
      valueType: expected.value_type === "integer" ? "integer" : "decimal",
      nullable: true,
    };
  // Publish collection structure, never the fact that the reference is empty.
  if (expected.type === "empty_table")
    return { type: "list", itemType: "json", nullable: true };
  if (expected.type !== "table") return undefined;
  if (!Array.isArray(expected.columns))
    throw new Error(
      "A typed table reference requires declared columns for its public answer format.",
    );
  return answerFormatSchema.parse({
    type: "table",
    columns: expected.columns.map((column) =>
      object(column)
        ? {
            name: column.name,
            type: column.type,
            ...(column.nullable === undefined
              ? {}
              : { nullable: column.nullable }),
          }
        : column,
    ),
  });
}

/** Extract the natural reference value for structural validation, never for target delivery. */
export function referenceAnswerValue(expected: Json): Json {
  if (!object(expected)) return expected;
  if (expected.type === "table" && Array.isArray(expected.rows))
    return expected.rows;
  if (
    (expected.type === "numeric" || expected.type === "string") &&
    Object.hasOwn(expected, "value")
  )
    return expected.value!;
  if (expected.type === "empty_table") return [];
  if (expected.type === "null_scalar") return null;
  return expected;
}

const integerPattern = "^[+-]?[0-9]+$";
function cellSchema(column: TableAnswerFormat["columns"][number]): Json {
  let schema: Json;
  if (column.type === "integer")
    schema = {
      anyOf: [
        {
          type: "integer",
          minimum: Number.MIN_SAFE_INTEGER,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        { type: "string", pattern: integerPattern, maxLength: 2048 },
      ],
    };
  else if (column.type === "decimal")
    schema = {
      anyOf: [
        { type: "number" },
        { type: "string", pattern: decimalStringPattern, maxLength: 2048 },
      ],
    };
  else if (column.type === "date") schema = { type: "string", format: "date" };
  else if (column.type === "datetime")
    schema = { type: "string", format: "date-time" };
  else schema = { type: column.type };
  return column.nullable ? { anyOf: [schema, { type: "null" }] } : schema;
}
export function answerFormatJsonSchema(format: AnswerFormat): Json {
  const validated = answerFormatSchema.parse(format);
  if (validated.type === "scalar")
    return cellSchema({
      name: "answer",
      type: validated.valueType,
      nullable: validated.nullable,
    });
  if (validated.type === "list")
    return {
      type: "array",
      maxItems: 1000,
      items:
        validated.itemType === "json"
          ? validated.nullable
            ? {}
            : { not: { type: "null" } }
          : cellSchema({
              name: "item",
              type: validated.itemType,
              nullable: validated.nullable,
            }),
    };
  return {
    type: "array",
    maxItems: 1000,
    items: {
      type: "object",
      properties: Object.fromEntries(
        validated.columns.map((column) => [column.name, cellSchema(column)]),
      ),
      required: validated.columns.map((column) => column.name),
      additionalProperties: false,
    },
  };
}
function validCell(
  column: TableAnswerFormat["columns"][number],
  value: Json,
): boolean {
  if (value === null) return column.nullable;
  if (column.type === "integer")
    return typeof value === "number"
      ? Number.isSafeInteger(value)
      : typeof value === "string" &&
          value.length <= 2048 &&
          new RegExp(integerPattern).test(value);
  if (column.type === "decimal")
    return (
      parseDecimal(value) !== undefined &&
      (typeof value !== "string" ||
        (value.length <= 2048 && new RegExp(decimalStringPattern).test(value)))
    );
  if (column.type === "date" || column.type === "datetime")
    return temporalValue(value, column.type) !== undefined;
  return typeof value === column.type;
}
export function validateSubmittedAnswer(
  format: AnswerFormat,
  answer: Json,
): { ok: boolean; error?: string } {
  const validated = answerFormatSchema.parse(format);
  if (validated.type === "scalar")
    return validCell(
      {
        name: "answer",
        type: validated.valueType,
        nullable: validated.nullable,
      },
      answer,
    )
      ? { ok: true }
      : {
          ok: false,
          error: `Submit one ${validated.valueType} value${validated.nullable ? " or null" : ""}, not a wrapper or list.`,
        };
  if (validated.type === "list") {
    if (!Array.isArray(answer) || answer.length > 1000)
      return {
        ok: false,
        error:
          "Submit a JSON array with at most 1,000 items. Use [] for an empty result.",
      };
    for (const [index, item] of answer.entries()) {
      const valid =
        validated.itemType === "json"
          ? item !== null || validated.nullable
          : validCell(
              {
                name: "item",
                type: validated.itemType,
                nullable: validated.nullable,
              },
              item,
            );
      if (!valid)
        return {
          ok: false,
          error: `Item ${index + 1} must be ${validated.itemType}${validated.nullable ? " or null" : ""}.`,
        };
    }
    return { ok: true };
  }
  if (!Array.isArray(answer) || answer.length > 1000)
    return {
      ok: false,
      error: "Submit an array of row objects with at most 1,000 rows.",
    };
  for (const [index, row] of answer.entries()) {
    if (
      !object(row) ||
      Object.keys(row).length !== validated.columns.length ||
      validated.columns.some((column) => !Object.hasOwn(row, column.name))
    )
      return {
        ok: false,
        error: `Row ${index + 1} must contain exactly these keys: ${validated.columns.map((column) => column.name).join(", ")}.`,
      };
    const invalid = validated.columns.find(
      (column) => !validCell(column, row[column.name]!),
    );
    if (invalid)
      return {
        ok: false,
        error: `Row ${index + 1}, column ${invalid.name} must be ${invalid.type}${invalid.nullable ? " or null" : ""}.`,
      };
  }
  return { ok: true };
}
