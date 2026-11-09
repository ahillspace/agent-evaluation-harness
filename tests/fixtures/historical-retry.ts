import type { Database } from "../../src/storage/database.js";

/** Seeds retired write-workflow records so current read paths remain verifiable. */
export function recordHistoricalRetry(
  db: Database,
  runId: string,
  retryRunId: string,
  resultIds: string[],
) {
  return db.transaction(() => {
    const retry = db.require("run", retryRunId);
    db.update("run", { ...retry, retryOf: { runId, resultIds } });
    const physical = db.list("result", { runId: retryRunId });
    return db.insert("retryApplication", {
      id: `historical_${retryRunId}`,
      runId,
      retryRunId,
      createdAt: retry.createdAt,
      bindings: resultIds.map((resultId) => {
        const logical = db.require("result", resultId);
        const source = physical.find(
          (result) =>
            result.questionId === logical.questionId &&
            result.repetition === logical.repetition,
        );
        if (!source?.completedAttemptId)
          throw new Error(
            "The historical fixture requires a completed physical answer.",
          );
        return { resultId, source: db.answerSource(source.completedAttemptId) };
      }),
      assessmentPassIds: [],
    });
  });
}
