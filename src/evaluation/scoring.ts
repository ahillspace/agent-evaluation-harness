import type {
  AnswerFormat,
  EvaluatorSettings,
  Json,
  Verdict,
} from "../contracts.js";
import { gradeCustom } from "./custom.js";
import { gradeTypedAnswer, validateReference } from "./typed-answers.js";
import { decimalsMatch, roundedDecimalsMatch } from "./decimal.js";
import { selectAnswer } from "./answer-policy.js";
import { temporalValue } from "../contracts/temporal.js";
import { rowsMatch } from "./row-matching.js";
import { errorMessage } from "../domain/errors.js";
import { validateEvaluationFormat } from "./submission-format.js";

function text(value: Json, settings: EvaluatorSettings): string {
  let result = typeof value === "string" ? value : JSON.stringify(value);
  if (settings.trimWhitespace) result = result.trim();
  if (settings.collapseWhitespace) result = result.replace(/\s+/g, " ");
  if (!settings.caseSensitive) result = result.toLocaleLowerCase("en-US");
  return result;
}
function equivalent(
  expected: Json,
  answer: Json,
  settings: EvaluatorSettings,
): boolean {
  if (typeof expected === "number" && typeof answer === "number")
    return decimalsMatch(
      expected,
      answer,
      settings.absoluteTolerance,
      settings.relativeTolerance,
    );
  if (Array.isArray(expected) && Array.isArray(answer)) {
    if (expected.length !== answer.length) return false;
    if (settings.arrayOrderMatters)
      return expected.every((item, index) =>
        equivalent(item, answer[index]!, settings),
      );
    if (expected.length > 500)
      throw new Error("Unordered JSON comparison exceeds the 500-item limit.");
    return rowsMatch(expected.length, (left, right) =>
      equivalent(expected[left]!, answer[right]!, settings),
    );
  }
  if (
    expected !== null &&
    answer !== null &&
    typeof expected === "object" &&
    typeof answer === "object" &&
    !Array.isArray(expected) &&
    !Array.isArray(answer)
  ) {
    const keys = Object.keys(expected);
    return (
      keys.length === Object.keys(answer).length &&
      keys.every(
        (key) =>
          Object.hasOwn(answer, key) &&
          equivalent(expected[key]!, answer[key]!, settings),
      )
    );
  }
  return expected === answer;
}
async function evaluate(
  expected: Json,
  answer: Json,
  settings: EvaluatorSettings,
  format?: AnswerFormat,
): Promise<Verdict> {
  if (settings.mode === "custom")
    return (
      validateEvaluationFormat(format, answer, settings) ??
      gradeCustom(expected, answer, settings.code ?? "")
    );
  if (settings.mode === "auto") {
    const typed = gradeTypedAnswer(expected, answer, settings, format);
    if (typed) return typed;
  }
  let mode = settings.mode;
  if (mode === "auto")
    mode =
      typeof expected === "number"
        ? "numeric"
        : typeof expected === "string"
          ? "text"
          : "json";
  if (
    mode === "json" &&
    typeof answer === "string" &&
    typeof expected !== "string"
  ) {
    try {
      answer = JSON.parse(answer) as Json;
    } catch {
      /* Preserve non-JSON answers for comparison. */
    }
  }
  const invalid = validateEvaluationFormat(format, answer, settings);
  if (invalid) return invalid;
  let correct = false;
  if (mode === "numeric") {
    correct =
      settings.decimalPlaces !== undefined
        ? roundedDecimalsMatch(expected, answer, settings.decimalPlaces)
        : decimalsMatch(
            expected,
            answer,
            settings.absoluteTolerance,
            settings.relativeTolerance,
          );
  } else if (mode === "text") {
    if (settings.dateComparison) {
      const reference = temporalValue(expected, settings.dateComparison);
      correct =
        reference !== undefined &&
        reference === temporalValue(answer, settings.dateComparison);
    } else correct = text(expected, settings) === text(answer, settings);
  } else if (mode === "exact")
    correct = equivalent(expected, answer, {
      ...settings,
      absoluteTolerance: 0,
      relativeTolerance: 0,
      arrayOrderMatters: true,
    });
  else {
    correct = equivalent(expected, answer, settings);
  }
  return {
    status: correct ? "correct" : "incorrect",
    explanation: correct
      ? `Answer matches the expected ${mode} value.`
      : `Answer does not match the expected ${mode} value.`,
  };
}
export async function grade(
  expected: Json,
  answer: Json,
  settings: EvaluatorSettings,
  format?: AnswerFormat,
): Promise<Verdict> {
  try {
    validateReference(expected, settings);
    if (settings.referenceDisposition === "needs_review")
      return {
        status: "unscorable",
        explanation: settings.referenceNote ?? "The reference requires review.",
        details: { reason: "reference_review", path: "" },
      };
    const selected = selectAnswer(answer, settings);
    if (selected.missing)
      return {
        status: "incorrect",
        explanation: "The configured answer path is missing.",
        details: {
          reason: "answer_path_missing",
          path: settings.answerPath ?? "",
        },
      };
    const result = await evaluate(expected, selected.value, settings, format);
    return result.status === "incorrect" && !result.details
      ? {
          ...result,
          details: {
            reason: "value_mismatch",
            path: settings.answerPath ?? "",
          },
        }
      : result;
  } catch (error) {
    return { status: "error", explanation: errorMessage(error) };
  }
}
