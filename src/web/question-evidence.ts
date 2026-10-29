import type { AssessmentPass, ResultRecord, RunView } from "../contracts.js";

/** Select presentation evidence from the application-provided answer provenance. */
export function questionEvidence(
  view: RunView,
  result: ResultRecord,
  pass?: AssessmentPass,
  selectedAttemptId?: string,
) {
  const judgment = pass?.judgments.find((item) => item.resultId === result.id);
  const original = view.attempts.filter(
    (item) => item.runId === view.run.id && item.resultId === result.id,
  );
  const answerAttemptId = pass
    ? (judgment?.attemptId ?? result.completedAttemptId)
    : (result.answerSource?.attemptId ?? result.completedAttemptId);
  const answerAttempt = view.attempts.find(
    (item) => item.id === answerAttemptId,
  );
  const history =
    answerAttempt && !original.some((item) => item.id === answerAttempt.id)
      ? [...original, answerAttempt]
      : original;
  const attempt =
    history.find((item) => item.id === selectedAttemptId) ??
    answerAttempt ??
    original.at(-1);
  return {
    attempt,
    history,
    completed: Boolean(answerAttempt && answerAttempt.status === "completed"),
    fromRerun: Boolean(attempt && attempt.runId !== view.run.id),
  };
}
