import type {
  AnswerSource,
  AttemptRecord,
  ResultRecord,
  RunRecord,
} from "../contracts.js";
import { AppError } from "../domain/errors.js";
import { digest } from "../domain/identity.js";
import { Database } from "../storage/database.js";

/** Logical results refer to physical evidence without changing its recorded owner. */
export class AnswerSources {
  constructor(private readonly db: Database) {}

  applications(runId: string) {
    return this.db.list("retryApplication", { runId });
  }
  history(runId: string) {
    return {
      retryApplications: this.applications(runId),
      retryRuns: this.db
        .runHeaders({ parentRunId: runId })
        .map((run) => ({ runId: run.id, name: run.name })),
    };
  }
  source(result: ResultRecord): AnswerSource | undefined {
    const applied = this.db.appliedAnswerSource(result.runId, result.id);
    if (applied) return applied;
    return result.completedAttemptId
      ? this.db.answerSource(result.completedAttemptId)
      : undefined;
  }
  results(runId: string): ResultRecord[] {
    const applied = new Map(
      this.applications(runId).flatMap((application) =>
        application.bindings.map(
          (binding) =>
            [
              binding.resultId,
              { ...binding.source, applicationId: application.id },
            ] as const,
        ),
      ),
    );
    return this.db.resultAnswerSources(runId).map((result) => {
      const answerSource = applied.get(result.id) ?? result.answerSource;
      if (!answerSource && result.completedAttemptId)
        throw new AppError(
          "not_found",
          `attempt ${result.completedAttemptId} was not found.`,
        );
      return { ...result, ...(answerSource ? { answerSource } : {}) };
    });
  }
  verify(result: ResultRecord, source: AnswerSource): AttemptRecord {
    const attempt = this.db.require("attempt", source.attemptId);
    const owner = this.db.require("result", source.resultId);
    const run = this.db.require("run", result.runId);
    const sourceRun = this.db.require("run", source.runId);
    if (
      attempt.runId !== source.runId ||
      attempt.resultId !== source.resultId ||
      owner.runId !== source.runId ||
      owner.questionId !== result.questionId ||
      owner.repetition !== result.repetition ||
      (source.runId !== result.runId &&
        (sourceRun.retryOf?.runId !== run.id ||
          !sourceRun.retryOf.resultIds.includes(result.id) ||
          digest(sourceRun.manifest) !== digest(run.manifest)))
    )
      throw new AppError(
        "incompatible_basis",
        "The saved answer does not belong to this question, repetition, and frozen configuration.",
      );
    if (
      attempt.status !== "completed" ||
      !attempt.output ||
      !attempt.finishedAt ||
      !attempt.evidenceHash ||
      source.evidenceHash !== attempt.evidenceHash ||
      digest(attempt.output) !== attempt.evidenceHash
    )
      throw new AppError(
        "evidence_integrity",
        "The saved answer does not match its completed, sealed evidence.",
      );
    return attempt;
  }
  /** Authorizes only owned evidence or evidence explicitly adopted by this Run. */
  authorize(
    runId: string,
    attemptId: string,
  ): { attempt: AttemptRecord; result: ResultRecord } {
    const attempt = this.db.require("attempt", attemptId);
    if (attempt.runId === runId)
      return { attempt, result: this.db.require("result", attempt.resultId) };
    const binding = this.applications(runId)
      .flatMap((application) => application.bindings)
      .find((item) => item.source.attemptId === attemptId);
    if (!binding)
      throw new AppError(
        "not_found",
        "The attempt does not belong to this run or an applied rerun.",
      );
    const result = this.db.require("result", binding.resultId);
    return { attempt: this.verify(result, binding.source), result };
  }
  /** Every physical attempt used by an application, including superseded applications. */
  physicalAttempts(runId: string): Map<string, string> {
    const attempts = new Map(
      this.db
        .list("result", { runId })
        .flatMap((result) =>
          result.attemptIds.map((attemptId) => [attemptId, runId] as const),
        ),
    );
    for (const application of this.applications(runId))
      for (const binding of application.bindings) {
        const sourceResult = this.db.require("result", binding.source.resultId);
        for (const attemptId of sourceResult.attemptIds)
          attempts.set(attemptId, binding.source.runId);
      }
    return attempts;
  }
  settled(run: Pick<RunRecord, "id" | "status">): boolean {
    return (
      [
        "completed",
        "failed",
        "cancelled",
        "halted",
        "paused",
        "interrupted",
      ].includes(run.status) &&
      !this.db.count("attempt", { runId: run.id, status: "running" }) &&
      !this.db.count("assessmentPass", { runId: run.id, status: "running" }) &&
      !this.db.count("jevAssessment", { runId: run.id, status: "pending" })
    );
  }
}
