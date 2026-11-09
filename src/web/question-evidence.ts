import type { AssessmentPass, ResultRecord, RunView } from "../contracts.js";

/** Select presentation evidence from the application-provided answer provenance. */
export function questionEvidence(
  view: RunView,
  result: ResultRecord,
  pass?: Pick<AssessmentPass, "judgments">,
  selectedAttemptId?: string,
) {
  const judgment = pass?.judgments.find((item) => item.resultId === result.id);
  const original = view.attempts.filter(
    (item) => item.runId === view.run.id && item.resultId === result.id,
  );
  const answerAttemptId = pass
    ? judgment?.attemptId
    : (result.answerSource?.attemptId ?? result.completedAttemptId);
  const answerAttempt = view.attempts.find(
    (item) => item.id === answerAttemptId,
  );
  const owners: Array<{ runId: string; resultId: string }> = [
    { runId: view.run.id, resultId: result.id },
  ];
  if (result.answerSource) owners.push(result.answerSource);
  if (judgment?.source) owners.push(judgment.source);
  for (const application of view.retryApplications ?? [])
    for (const binding of application.bindings)
      if (binding.resultId === result.id) owners.push(binding.source);
  const history = view.attempts.filter(
    (item) =>
      item.id === answerAttemptId ||
      owners.some(
        (owner) =>
          owner.runId === item.runId && owner.resultId === item.resultId,
      ),
  );
  const attempt =
    history.find((item) => item.id === selectedAttemptId) ??
    answerAttempt ??
    (pass
      ? original.findLast((item) => item.status !== "completed")
      : original.at(-1));
  return {
    attempt,
    history,
    completed: Boolean(answerAttempt && answerAttempt.status === "completed"),
    fromRerun: Boolean(attempt && attempt.runId !== view.run.id),
  };
}
