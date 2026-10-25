import type {
  AssessmentPass,
  CommandInput,
  CommandResultMap,
  PassJudgment,
  RetryApplyEligibility,
  RunRetryApplication,
} from "../contracts.js";
import { AppError } from "../domain/errors.js";
import { digest, id, now } from "../domain/identity.js";
import { Database, type RunHeader } from "../storage/database.js";
import { AnswerSources } from "./answer-sources.js";
import { AssessmentPassService, measurePass } from "./assessment-passes.js";
import { EvaluationService } from "./evaluations.js";

/** Applies sealed retry evidence through new assessment passes, without provider work. */
export class RetryApplicationService {
  private readonly answers: AnswerSources;
  constructor(
    private readonly db: Database,
    private readonly passes: AssessmentPassService,
    private readonly evaluations: EvaluationService,
  ) {
    this.answers = new AnswerSources(db);
  }
  eligibility(retry: RunHeader): RetryApplyEligibility | undefined {
    if (!retry.retryOf) return undefined;
    const original = this.db.runHeader(retry.retryOf.runId);
    const base = {
      originalRunId: original.id,
      resultIds: [] as string[],
      alreadyAppliedResultIds: [] as string[],
      replacementResultIds: [] as string[],
    };
    if (!this.answers.settled(original) || !this.answers.settled(retry))
      return {
        ...base,
        available: false,
        reason:
          "Wait for the original run and rerun to stop before applying answers.",
      };
    if (original.manifestHash !== retry.manifestHash)
      return {
        ...base,
        available: false,
        reason: "The rerun uses a different frozen configuration.",
      };
    const candidates = new Map(
      this.db
        .list("result", { runId: retry.id })
        .map((result) => [
          JSON.stringify([result.questionId, result.repetition]),
          result,
        ]),
    );
    const originalResults = new Map(
      this.answers.results(original.id).map((result) => [result.id, result]),
    );
    for (const originalId of retry.retryOf.resultIds) {
      const result = originalResults.get(originalId);
      if (!result) continue;
      const candidate = candidates.get(
        JSON.stringify([result.questionId, result.repetition]),
      );
      if (
        result.runId !== original.id ||
        result.status !== "failed" ||
        candidate?.status !== "completed" ||
        !candidate.completedAttemptId
      )
        continue;
      base.resultIds.push(result.id);
      if (result.answerSource?.attemptId === candidate.completedAttemptId)
        base.alreadyAppliedResultIds.push(result.id);
      else if (result.answerSource?.applicationId)
        base.replacementResultIds.push(result.id);
    }
    const available = base.resultIds.some(
      (resultId) => !base.alreadyAppliedResultIds.includes(resultId),
    );
    return {
      ...base,
      available,
      ...(!available
        ? {
            reason: base.resultIds.length
              ? "These rerun answers are already applied."
              : "This rerun has no completed answers for failed original questions.",
          }
        : {}),
    };
  }
  enrich<T extends { run: { id: string } }>(view: T) {
    const run = this.db.runHeader(view.run.id);
    const retryApplyEligibility = this.eligibility(run);
    const retryRuns = this.db
      .runHeaders({ parentRunId: run.id })
      .map((retry) => {
        const { originalRunId: _original, ...eligibility } =
          this.eligibility(retry)!;
        return { runId: retry.id, name: retry.name, ...eligibility };
      });
    return {
      ...view,
      retryApplications: this.answers.applications(run.id),
      retryRuns,
      ...(retryApplyEligibility ? { retryApplyEligibility } : {}),
    };
  }
  async apply(
    input: CommandInput<"runs.apply-retry">,
  ): Promise<CommandResultMap["runs.apply-retry"]> {
    const key = `apply-retry:${input.idempotencyKey}`,
      requestHash = digest(input);
    const prior = this.db.idempotent(key, requestHash);
    if (prior)
      return {
        ...(prior.response as CommandResultMap["runs.apply-retry"]),
        alreadyApplied: true,
      };
    const run = this.db.require("run", input.runId),
      retry = this.db.require("run", input.retryRunId);
    if (retry.retryOf?.runId !== run.id)
      throw new AppError(
        "incompatible_basis",
        "Select a failed-question rerun linked to this original run.",
      );
    const eligibility = this.eligibility(this.db.runHeader(retry.id))!;
    if (
      !this.answers.settled(run) ||
      !this.answers.settled(retry) ||
      digest(run.manifest) !== digest(retry.manifest)
    )
      throw new AppError(
        "invalid_state",
        eligibility.reason ?? "The runs are not ready to apply.",
      );
    const selected = input.resultIds ?? eligibility.resultIds;
    if (
      !selected.length ||
      new Set(selected).size !== selected.length ||
      selected.some((resultId) => !eligibility.resultIds.includes(resultId))
    )
      throw new AppError(
        "invalid_input",
        "Select completed rerun answers for failed original questions, without duplicates.",
      );
    const applicationsBefore = this.answers.applications(run.id);
    const applicationId = id("retryapplication");
    const bindings: RunRetryApplication["bindings"] = [];
    for (const resultId of selected) {
      const result = this.db.require("result", resultId);
      const sourceResult = this.db
        .list("result", { runId: retry.id })
        .find(
          (item) =>
            item.questionId === result.questionId &&
            item.repetition === result.repetition,
        )!;
      const attempt = this.db.require(
        "attempt",
        sourceResult.completedAttemptId!,
      );
      const source = {
        runId: retry.id,
        resultId: sourceResult.id,
        attemptId: attempt.id,
        evidenceHash: attempt.evidenceHash ?? "",
        applicationId,
      };
      this.answers.verify(result, source);
      const existing = this.answers.source(result);
      if (existing?.attemptId === source.attemptId) continue;
      if (existing?.applicationId && !input.replaceApplied)
        throw new AppError(
          "replacement_acknowledgment_required",
          "This question already uses another rerun answer. Confirm replacement before applying this answer.",
        );
      bindings.push({ resultId, source });
    }
    if (!bindings.length) {
      const application =
        applicationsBefore.findLast((item) =>
          selected.every((resultId) =>
            item.bindings.some((binding) => binding.resultId === resultId),
          ),
        ) ?? applicationsBefore.at(-1)!;
      const receipt = {
        ...this.result(application, true),
        appliedResultIds: selected,
      };
      this.db.remember(
        key,
        requestHash,
        "retryApplication",
        application.id,
        receipt,
      );
      return receipt;
    }
    const effectiveBindings = new Map(
      applicationsBefore
        .flatMap((application) => application.bindings)
        .map((binding) => [binding.resultId, binding]),
    );
    for (const binding of bindings)
      effectiveBindings.set(binding.resultId, binding);
    const originals = this.passes.list(run.id, true);
    const sourcePasses = new Map([
      [retry.id, this.passes.list(retry.id, true)],
    ]);
    const selectedPass =
      originals.find((pass) => pass.id === run.selectedAssessmentPassId) ??
      originals[0]!;
    const computedFamilies = originals
      .filter((pass) => pass.id.startsWith("original_"))
      .map(
        (original) =>
          originals.findLast(
            (pass) =>
              pass.retryApplicationId &&
              pass.source === original.source &&
              digest(pass.configuration) === digest(original.configuration),
          ) ?? original,
      );
    const created = new Map<string, AssessmentPass>();
    const derive = async (parent: AssessmentPass): Promise<AssessmentPass> => {
      const cached = created.get(parent.id);
      if (cached) return cached;
      const underlying =
        parent.source === "human" && parent.parentPassId
          ? await derive(this.passes.get(run.id, parent.parentPassId))
          : undefined;
      const judgments: PassJudgment[] = [];
      for (const previous of parent.judgments) {
        const binding = effectiveBindings.get(previous.resultId);
        if (!binding || previous.attemptId === binding.source.attemptId) {
          judgments.push(
            parent.source === "llm" &&
              previous.attemptId &&
              (previous.response || previous.status === "error")
              ? {
                  ...previous,
                  judgmentId:
                    previous.judgmentId ?? `original_llm_${previous.attemptId}`,
                }
              : previous,
          );
          continue;
        }
        if (underlying) {
          judgments.push(
            underlying.judgments.find(
              (item) => item.resultId === previous.resultId,
            )!,
          );
          continue;
        }
        const result = this.db.require("result", binding.resultId);
        const attempt = this.answers.verify(result, binding.source);
        const base: PassJudgment = {
          resultId: result.id,
          attemptId: attempt.id,
          evidenceHash: attempt.evidenceHash,
          source: { runId: attempt.runId, resultId: attempt.resultId },
          status: "unjudged",
          explanation:
            "No compatible saved judgment exists for this rerun answer. Judge this saved answer to complete the score.",
        };
        if (parent.source === "deterministic") {
          const assessed = await this.evaluations.assess(
            run,
            result,
            attempt,
            parent.configuration.evaluator,
            parent.configuration.referenceBank,
          );
          const verdict = assessed.deterministic;
          judgments.push({
            ...base,
            status:
              verdict.status === "unavailable"
                ? "unjudged"
                : verdict.status === "unscorable"
                  ? "excluded"
                  : verdict.status,
            explanation: verdict.explanation,
            ...(verdict.details ? { details: verdict.details } : {}),
          });
        } else {
          if (!sourcePasses.has(attempt.runId))
            sourcePasses.set(
              attempt.runId,
              this.passes.list(attempt.runId, true),
            );
          const compatible = sourcePasses
            .get(attempt.runId)!
            .findLast(
              (pass) =>
                pass.source === parent.source &&
                digest(pass.configuration) === digest(parent.configuration) &&
                pass.status !== "running",
            );
          const saved = compatible?.judgments.find(
            (item) =>
              item.resultId === attempt.resultId &&
              item.attemptId === attempt.id &&
              item.evidenceHash === attempt.evidenceHash,
          );
          judgments.push(
            saved
              ? {
                  ...saved,
                  ...base,
                  status: saved.status,
                  explanation: saved.explanation,
                  ...(parent.source === "llm"
                    ? {
                        judgmentId:
                          saved.judgmentId ?? `original_llm_${attempt.id}`,
                      }
                    : {}),
                }
              : base,
          );
        }
      }
      const excludedResultIds = judgments
        .filter((judgment) => judgment.status === "excluded")
        .map((judgment) => judgment.resultId);
      const next = measurePass({
        ...parent,
        id: id("pass"),
        retryApplicationId: applicationId,
        parentPassId: underlying?.id ?? parent.id,
        name: `${parent.name.replace(/ \(rerun answers\)$/, "")} (rerun answers)`,
        createdAt: now(),
        finishedAt: now(),
        status: "completed",
        judgments,
        basis: {
          ...parent.basis,
          eligibleResultIds: judgments
            .filter((judgment) => judgment.status !== "excluded")
            .map((judgment) => judgment.resultId),
          excludedResultIds,
        },
      });
      created.set(parent.id, next);
      return next;
    };
    for (const family of computedFamilies) await derive(family);
    const selectedNext = await derive(selectedPass);
    return this.db.transaction(() => {
      const repeated = this.db.idempotent(key, requestHash);
      if (repeated)
        return {
          ...(repeated.response as CommandResultMap["runs.apply-retry"]),
          alreadyApplied: true,
        };
      if (
        !this.answers.settled(this.db.require("run", run.id)) ||
        !this.answers.settled(this.db.require("run", retry.id)) ||
        digest(this.answers.applications(run.id)) !==
          digest(applicationsBefore) ||
        this.db.require("run", run.id).selectedAssessmentPassId !==
          run.selectedAssessmentPassId
      )
        throw new AppError(
          "conflict",
          "The run changed while applying rerun answers. Review its current results and try again.",
        );
      for (const binding of bindings)
        this.answers.verify(
          this.db.require("result", binding.resultId),
          binding.source,
        );
      for (const pass of created.values())
        this.db.insert("assessmentPass", pass);
      const application = this.db.insert("retryApplication", {
        id: applicationId,
        runId: run.id,
        retryRunId: retry.id,
        createdAt: now(),
        bindings,
        assessmentPassIds: [...created.values()].map((pass) => pass.id),
      });
      this.db.update("run", {
        ...this.db.require("run", run.id),
        selectedAssessmentPassId: selectedNext.id,
      });
      this.db.remember(
        key,
        requestHash,
        "retryApplication",
        application.id,
        this.result(application, false),
      );
      this.db.append({
        runId: run.id,
        type: "run.retry.applied",
        message: `Applied ${bindings.length} saved rerun answer${bindings.length === 1 ? "" : "s"}. Original evidence and scores remain available.`,
        data: {
          applicationId,
          retryRunId: retry.id,
          resultIds: bindings.map((binding) => binding.resultId),
          assessmentPassIds: application.assessmentPassIds,
        },
      });
      return this.result(application, false);
    });
  }
  private result(
    application: RunRetryApplication,
    alreadyApplied: boolean,
  ): CommandResultMap["runs.apply-retry"] {
    return {
      applicationId: application.id,
      appliedResultIds: application.bindings.map((binding) => binding.resultId),
      assessmentPassIds: application.assessmentPassIds,
      alreadyApplied,
    };
  }
}
