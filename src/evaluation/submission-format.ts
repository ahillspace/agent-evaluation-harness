import type {
  AnswerFormat,
  EvaluatorSettings,
  Json,
  Verdict,
} from "../contracts.js";
import { validateSubmittedAnswer } from "../contracts/answer-format.js";
import { isIntegerDecimal, parseDecimal } from "../contracts/numeric.js";
import { temporalValue } from "../contracts/temporal.js";

/** Validate an already selected representation using the evaluator's accepted numeric and temporal syntax. */
export function validateEvaluationFormat(
  format: AnswerFormat | undefined,
  answer: Json,
  settings: EvaluatorSettings,
): Verdict | undefined {
  if (!format) return undefined;
  let invalidTemporal = false;
  const project = (
    value: Json,
    type: string,
    rule: { dateComparison?: "calendar_date" | "instant" } = settings,
  ): Json => {
    if (value === null) return value;
    if (rule.dateComparison && ["date", "datetime", "string"].includes(type)) {
      const temporal = temporalValue(value, rule.dateComparison);
      if (temporal === undefined) invalidTemporal = true;
      return temporal ?? value;
    }
    if (
      type === "integer" &&
      typeof value === "string" &&
      isIntegerDecimal(value)
    ) {
      const decimal = parseDecimal(value)!;
      return (decimal.coefficient / 10n ** BigInt(decimal.scale)).toString();
    }
    return type === "decimal" &&
      typeof value === "string" &&
      parseDecimal(value) !== undefined
      ? value.trim()
      : value;
  };
  const effectiveType = (
    type: string,
    rule: { dateComparison?: "calendar_date" | "instant" },
  ) =>
    rule.dateComparison && ["date", "datetime", "string"].includes(type)
      ? ("string" as const)
      : type;
  let projected = answer;
  let effectiveFormat = format;
  if (format.type === "scalar") {
    projected = project(answer, format.valueType);
    effectiveFormat = {
      ...format,
      valueType: effectiveType(
        format.valueType,
        settings,
      ) as typeof format.valueType,
    };
  } else if (format.type === "list" && Array.isArray(answer)) {
    projected = answer.map((value) => project(value, format.itemType));
    effectiveFormat = {
      ...format,
      itemType: effectiveType(
        format.itemType,
        settings,
      ) as typeof format.itemType,
    };
  } else if (format.type === "table" && Array.isArray(answer)) {
    projected = answer.map((row) => {
      if (row === null || typeof row !== "object" || Array.isArray(row))
        return row;
      return Object.fromEntries(
        Object.entries(row).map(([key, value]) => {
          const column = format.columns.find((item) => item.name === key);
          return [
            key,
            column
              ? project(value, column.type, settings.columnRules?.[key] ?? {})
              : value,
          ];
        }),
      );
    });
    effectiveFormat = {
      ...format,
      columns: format.columns.map((column) => ({
        ...column,
        type: effectiveType(
          column.type,
          settings.columnRules?.[column.name] ?? {},
        ) as typeof column.type,
      })),
    };
  }
  const result = validateSubmittedAnswer(effectiveFormat, projected);
  return result.ok && !invalidTemporal
    ? undefined
    : {
        status: "incorrect",
        explanation: invalidTemporal
          ? "The submitted answer does not satisfy the declared temporal representation policy."
          : (result.error ??
            "The submitted answer does not satisfy its public format."),
        details: { reason: "public_format", path: settings.answerPath ?? "" },
      };
}
