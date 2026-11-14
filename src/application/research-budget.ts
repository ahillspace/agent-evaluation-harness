import type { AttemptRecord, ResearchRecord } from "../contracts.js";
import { researchBudgetReason } from "../domain/research-budget.js";
import { Database } from "../storage/database.js";

export function attemptBudgetResearchSessionId(
  db: Database,
  attempt: Pick<
    AttemptRecord,
    "runId" | "executionId" | "budgetResearchSessionId"
  >,
): string | undefined {
  return attempt.executionId === undefined
    ? db.require("run", attempt.runId).researchSessionId
    : attempt.budgetResearchSessionId;
}

export function checkResearchBudget(
  db: Database,
  session: ResearchRecord,
  additionalTargets = 0,
  additionalRunId?: string,
): string | undefined {
  const runIds = additionalRunId
    ? [...new Set([...session.runIds, additionalRunId])]
    : session.runIds;
  const attempts = db
    .list("attempt", { runId: runIds })
    .filter(
      (attempt) => attemptBudgetResearchSessionId(db, attempt) === session.id,
    );
  const judgeUsage = runIds.flatMap((runId) =>
    db
      .originalJudgeUsage(
        runId,
        attempts
          .filter((attempt) => attempt.runId === runId)
          .map((attempt) => attempt.id),
      )
      .map((report) => report.usage),
  );
  return researchBudgetReason(
    session,
    attempts,
    db.researchAccounting(session.id),
    additionalTargets,
    Date.now(),
    [
      ...judgeUsage,
      ...db
        .list("jevAssessment", { runId: runIds })
        .filter(
          (record) =>
            record.kind === "original" &&
            attempts.some((attempt) => attempt.id === record.attemptId),
        )
        .map((record) => record.usage),
    ],
  );
}
