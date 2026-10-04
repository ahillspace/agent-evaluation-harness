import type {
  BankRevision,
  CalibrationReport,
  EvaluatorSettings,
} from "../contracts.js";
import { AppError } from "../domain/errors.js";
import { grade } from "../evaluation/scoring.js";
import { validateReference } from "../evaluation/typed-answers.js";

export function validateBankPolicies(
  bank: Pick<BankRevision, "questions">,
  settings: EvaluatorSettings,
): void {
  for (const questionId of Object.keys(settings.questionOverrides))
    if (!bank.questions.some((question) => question.id === questionId))
      throw new AppError(
        "invalid_input",
        `Evaluator override names an unknown question: ${questionId}.`,
      );
  for (const question of bank.questions) {
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
  for (const example of settings.calibrationExamples ?? [])
    if (!bank.questions.some((question) => question.id === example.questionId))
      throw new AppError(
        "invalid_input",
        `Calibration example ${example.id} names an unknown question: ${example.questionId}.`,
      );
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
    const actual = await grade(question.expected, example.answer, {
      ...settings,
      ...settings.questionOverrides[question.id],
    });
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
