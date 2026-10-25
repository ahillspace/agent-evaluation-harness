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
  const judgeUsage = runIds.flatMap((runId) =>
    db.originalJudgeUsage(runId).map((report) => report.usage),
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
