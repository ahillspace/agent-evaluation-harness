import type {
  CommandInput,
  ResultRecord,
  RunRecord,
  RuntimePort,
  RunView,
} from "../contracts.js";
import { savedTarget } from "../contracts/targets.js";
import { AppError } from "../domain/errors.js";
import { digest, id, now } from "../domain/identity.js";
import { isTerminal } from "../domain/lifecycle.js";
import { AnswerSources } from "./answer-sources.js";
import { Database } from "../storage/database.js";

/** Creates independent failed-slot runs without changing source evidence or research decisions. */
export class RunRetries {
  constructor(
    private readonly db: Database,
    private readonly runtime: RuntimePort,
    private readonly isActive: (runId: string) => boolean,
  ) {}
  async create(input: CommandInput<"runs.retry-failed">): Promise<RunRecord> {
    const key = `retry:${input.idempotencyKey}`,
      requestHash = digest(input);
    const previous = this.db.idempotent(key, requestHash);
    if (previous) return this.db.require("run", previous.id);
    const source = this.db.require("run", input.runId);
    if (
      this.isActive(source.id) ||
      !["completed", "failed", "halted", "cancelled", "paused"].includes(
        source.status,
      )
    )
      throw new AppError(
        "invalid_state",
        "Stop active work before retrying failed questions.",
      );
    const failed = this.db
      .list("result", { runId: source.id })
      .filter((result) => result.status === "failed");
    const selected = input.resultIds
      ? input.resultIds.map((resultId) =>
          failed.find((result) => result.id === resultId),
        )
      : failed.filter((result) => !new AnswerSources(this.db).source(result));
    if (
      !selected.length ||
      selected.some((result) => !result) ||
      new Set(selected.map((result) => result!.id)).size !== selected.length
    )
      throw new AppError(
        "invalid_input",
        "Select only failed results, without duplicates. Completed answers cannot be retried here.",
      );
    const results = selected as ResultRecord[];
    const target = savedTarget(source.manifest);
    const requiresAcknowledgment = this.requiresAcknowledgment(source, results);
    if (requiresAcknowledgment && !input.acknowledgeDuplicateWork)
      throw new AppError(
        "duplicate_work_acknowledgment_required",
        "Retrying may duplicate tool or remote work. Acknowledge that risk before continuing.",
      );
    await this.runtime.resolveTarget(target);
    if (target.kind === "external")
      await this.runtime.externalTargets.retain(target);
    const retry = this.db.transaction(() => {
      if (
        this.isActive(source.id) ||
        (this.db.require("run", source.id).intent === "run" &&
          !isTerminal(this.db.require("run", source.id).status))
      )
        throw new AppError(
          "invalid_state",
          "The original run resumed while retry was being prepared.",
        );
      const existing = this.db.idempotent(key, requestHash);
      if (existing) return this.db.require("run", existing.id);
      const record = this.db.insert("run", {
        id: id("run"),
        name: `${source.name} - failed question retry`,
        createdAt: now(),
        updatedAt: now(),
        status: "queued",
        intent: "run",
        manifest: source.manifest,
        retryOf: {
          runId: source.id,
          resultIds: results.map((result) => result.id),
        },
      });
      for (const result of results)
        this.db.insert("result", {
          id: id("result"),
          runId: record.id,
          questionId: result.questionId,
          repetition: result.repetition,
          status: "pending",
          attemptIds: [],
        });
      this.db.remember(key, requestHash, "run", record.id);
      this.db.append({
        runId: record.id,
        type: "run.retry.created",
        message:
          "Retrying selected failed slots with the original frozen configuration. Original attempts and scores remain unchanged.",
        data: {
          sourceRunId: source.id,
          resultIds: results.map((result) => result.id),
        },
      });
      return record;
    });
    return retry;
  }
  eligibility(
    run: RunRecord,
    results: ResultRecord[],
  ): NonNullable<RunView["retryEligibility"]> {
    const failed = results.filter(
      (result) =>
        result.status === "failed" &&
        !new AnswerSources(this.db).source(result),
    );
    const settled =
      !this.isActive(run.id) &&
      ["completed", "failed", "halted", "cancelled", "paused"].includes(
        run.status,
      );
    return {
      available: settled && failed.length > 0,
      resultIds: failed.map((result) => result.id),
      requiresAcknowledgment: this.requiresAcknowledgment(run, failed),
      ...(!settled
        ? { reason: "Stop active work before retrying failed questions." }
        : !failed.length
          ? {
              reason:
                "There are no failed question executions. Incorrect answers are not retried.",
            }
          : {}),
    };
  }
  private requiresAcknowledgment(
    run: RunRecord,
    results: ResultRecord[],
  ): boolean {
    return (
      savedTarget(run.manifest).kind === "external" ||
      results.some((result) => {
        const attemptId = result.attemptIds.at(-1);
        const safety = attemptId
          ? this.db.require("attempt", attemptId).failure?.classification
              ?.retrySafety
          : undefined;
        return !["not-started", "no-side-effects"].includes(
          safety ?? "unknown",
        );
      })
    );
  }
}
