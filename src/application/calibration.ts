import type {
  BankRevision,
  CalibrationReport,
  EvaluatorSettings,
  Question,
} from "../contracts.js";
import { AppError } from "../domain/errors.js";
import { grade } from "../evaluation/scoring.js";
import { validateAuthoredPolicy } from "../evaluation/authored-policy.js";
import { validateReference } from "../evaluation/typed-answers.js";

function validateQuestionReference(
  question: Question,
  settings: EvaluatorSettings,
): void {
  try {
    validateReference(question.expected, {
      ...settings,
      ...settings.questionOverrides[question.id],
    });
  } catch (error) {
    throw new AppError(
      "invalid_input",
      `Question ${question.id}: ${(error as Error).message}`,
    );
  }
}

function validateQuestionApplicability(
  question: Question,
  settings: EvaluatorSettings,
): void {
  try {
    validateAuthoredPolicy(question.expected, {
      ...settings,
      ...settings.questionOverrides[question.id],
    });
  } catch (error) {
    throw new AppError(
      "invalid_input",
      `Question ${question.id}: ${(error as Error).message}`,
    );
  }
}

export function validateQuestionPolicy(
  question: Question,
  settings: EvaluatorSettings,
): void {
  validateQuestionReference(question, settings);
  validateQuestionApplicability(question, settings);
}

/** Structural compatibility also applies when exporting existing immutable revisions. */
export function validateBankReferences(
  bank: Pick<BankRevision, "questions">,
  settings: EvaluatorSettings,
): void {
  for (const questionId of Object.keys(settings.questionOverrides))
    if (!bank.questions.some((question) => question.id === questionId))
      throw new AppError(
        "invalid_input",
        `Evaluator override names an unknown question: ${questionId}.`,
      );
  for (const question of bank.questions)
    validateQuestionReference(question, settings);
  for (const example of settings.calibrationExamples ?? [])
    if (!bank.questions.some((question) => question.id === example.questionId))
      throw new AppError(
        "invalid_input",
        `Calibration example ${example.id} names an unknown question: ${example.questionId}.`,
      );
}

/** New authored policies must have an active grading consumer. */
export function validateBankPolicies(
  bank: Pick<BankRevision, "questions">,
  settings: EvaluatorSettings,
): void {
  validateBankReferences(bank, settings);
  for (const question of bank.questions)
    validateQuestionApplicability(question, settings);
}

export async function calibrateSettings(
  bank: BankRevision,
  settings: EvaluatorSettings,
): Promise<CalibrationReport> {
  validateBankPolicies(bank, settings);
  const results: CalibrationReport["results"] = [];
  for (const example of settings.calibrationExamples ?? []) {
    const question = bank.questions.find(
      (item) => item.id === example.questionId,
    )!;
    const actual = await grade(
      question.expected,
      example.answer,
      {
        ...settings,
        ...settings.questionOverrides[question.id],
      },
      question.answerFormat,
    );
    results.push({
      id: example.id,
      questionId: question.id,
      expectedStatus: example.expectedStatus,
      actual,
      passed: actual.status === example.expectedStatus,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return {
    bankRevisionId: bank.id,
    total: results.length,
    passed: results.filter((item) => item.passed).length,
    results,
  };
}
