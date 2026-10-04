import type { ResearchRecord } from "../contracts.js";
import { researchBudgetReason } from "../domain/research-budget.js";
import { Database } from "../storage/database.js";

export function checkResearchBudget(
  db: Database,
  session: ResearchRecord,
  additionalTargets = 0,
  additionalRunId?: string,
): string | undefined {
  const runIds = additionalRunId
    ? [...new Set([...session.runIds, additionalRunId])]
    : session.runIds;
  const attempts = db.list("attempt", { runId: runIds });
  const judgeUsage = attempts
    .filter(
      (attempt) =>
        attempt.status === "completed" &&
        db.require("run", attempt.runId).manifest.judge.enabled,
    )
    .map(
      (attempt) =>
        db
          .list("assessment", { resultId: attempt.resultId })
          .find((assessment) => assessment.attemptId === attempt.id)?.judge
          ?.usage,
    );
  return researchBudgetReason(
    session,
    attempts,
    additionalTargets,
    Date.now(),
    [
      ...judgeUsage,
      ...db
        .list("jevAssessment", { runId: runIds })
        .filter((record) => record.kind === "original")
        .map((record) => record.usage),
    ],
  );
}
