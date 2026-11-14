import { setTimeout as wait } from "node:timers/promises";
import {
  automaticRetryDelay,
  classifyExecutionFailure,
} from "../domain/execution-retry.js";
import { publicEvaluationGuidance } from "../contracts/evaluation-guidance.js";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  targetOutputSchema,
  type AgentConfig,
  type AttemptRecord,
  type Json,
  type LaunchInput,
  type ResultRecord,
  type RunRecord,
  type RunExecution,
  type RuntimePort,
  type RunView,
  type RunObservation,
  type AttemptDetail,
  type FrozenJevJudge,
  type CommandInput,
  publicQuestionSchema,
  jsonSchema,
} from "../contracts.js";
import { AppError, errorMessage } from "../domain/errors.js";
import { digest, id, now } from "../domain/identity.js";
import {
  allowedActions,
  controlTransition,
  isTerminal,
  faultTransition,
  settlementStatus,
  cancellationRequested,
} from "../domain/lifecycle.js";
import { Database } from "../storage/database.js";
import { EvaluationService } from "./evaluations.js";
import { checkResearchBudget } from "./research-budget.js";
import { JevService } from "./jev.js";
import { LlmJudgeService } from "./llm-judge.js";
import { savedTarget, managedAgent } from "../contracts/targets.js";
import { UsageProjection } from "./usage-projection.js";
import { TargetInvocations } from "./target-invocations.js";
import { validateTargetEvidence } from "./evidence-requirements.js";
import { AnswerSources } from "./answer-sources.js";
import { AssessmentPassService } from "./assessment-passes.js";

/** Internal atomic boundary for a Research-owned Run control request. */
export interface ResearchControlAdmission {
  targetRunId?: string;
  commit(): void;
  activate(): void;
}

export class RunService {
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly controllers = new Map<
    string,
    Map<string, AbortController>
  >();
  private closing = false;
  private readonly admissionLimits = new Map<string, number>();
  private readonly executingCounts = new Map<string, number>();
  private readonly admissionWaiters = new Map<string, Set<() => void>>();
  private readonly invocations: TargetInvocations;
  constructor(
    private readonly db: Database,
    private readonly runtime: RuntimePort,
    private readonly evaluation: EvaluationService,
    private readonly directory: string,
    private readonly jev: JevService,
    private readonly passes: AssessmentPassService,
    private readonly usage = new UsageProjection(
      db,
      runtime.normalizeRecordedUsage?.bind(runtime),
    ),
  ) {
    this.invocations = new TargetInvocations(directory, runtime);
  }
  async recover(): Promise<string[]> {
    const recovered = await this.invocations.recover();
    for (const attempt of this.db.list("attempt", { status: "running" })) {
      if (attempt.adapterCheckpoint !== undefined) {
        const run = this.db.require("run", attempt.runId);
        const report =
          recovered.get(attempt.id) ??
          (await this.runtime.recoverTarget(
            savedTarget(run.manifest),
            attempt.adapterCheckpoint,
          ));
        this.db.update("attempt", {
          ...attempt,
          remoteCompletion: report.remoteCompletion,
        });
        if (report.cleanup === "unavailable")
          throw new AppError(
            "cleanup_failed",
            "Target resource recovery requires attention before new work.",
          );
      }
    }
    const recoveredRunIds: string[] = [];
    this.db.transaction(() => {
      for (const attempt of this.db.list("attempt", { status: "running" }))
        this.db.update("attempt", {
          ...attempt,
          status: "interrupted",
          finishedAt: now(),
          error: "The engine stopped before this attempt completed.",
        });
      for (const result of this.db.list("result", { status: "running" }))
        this.db.update("result", { ...result, status: "interrupted" });
      for (const run of this.db.list("run", {
        status: ["queued", "running", "pausing", "halting", "cancelling"],
      })) {
        recoveredRunIds.push(run.id);
        const status = cancellationRequested(run)
          ? "cancelled"
          : run.intent === "pause"
            ? "paused"
            : "halted";
        this.db.update("run", {
          ...run,
          status,
          ...(run.execution
            ? {
                execution: {
                  ...run.execution,
                  activeSegmentStartedAt: undefined,
                  stopReason:
                    run.execution.stopReason === "failed"
                      ? "failed"
                      : "interrupted",
                  ...(status === "cancelled" ? { settledAt: now() } : {}),
                },
                ...(run.execution.activeSegmentStartedAt
                  ? { activeDurationIncomplete: true }
                  : {}),
              }
            : {}),
          intent: cancellationRequested(run)
            ? "cancel"
            : run.intent === "pause"
              ? "pause"
              : "halt",
          updatedAt: now(),
        });
        this.db.append({
          runId: run.id,
          type: "run.recovered",
          message: "Recovered saved work after an engine interruption.",
        });
      }
    });
    return recoveredRunIds;
  }
  completeRecovery(runIds: string[]): void {
    for (const runId of runIds) this.settleIntent(runId);
  }
  async launch(
    input: LaunchInput,
    researchSessionId?: string,
    frozenJevJudge?: FrozenJevJudge,
    commitResearchLaunch?: (run: RunRecord) => void,
  ): Promise<RunView> {
    if (this.closing)
      throw new AppError("unavailable", "The engine is shutting down.");
    const requestHash = digest(input);
    const key = input.idempotencyKey
      ? `run:${input.idempotencyKey}`
      : undefined;
    if (key) {
      const existing = this.db.idempotent(key, requestHash);
      if (existing) {
        if (commitResearchLaunch)
          this.db.transaction(() =>
            commitResearchLaunch(this.db.require("run", existing.id)),
          );
        return this.view(existing.id);
      }
    }
    const bank = this.db.require("bankRevision", input.bankRevisionId);
    const catalogBank = this.db.require("bank", bank.bankId);
    const evaluator = this.db.require(
      "evaluator",
      input.evaluatorRevisionId ?? catalogBank.activeEvaluatorRevisionId,
    );
    if (evaluator.bankId !== bank.bankId)
      throw new AppError(
        "invalid_input",
        "The evaluator must belong to the selected bank.",
      );
    const questions = input.questionIds
      ? input.questionIds.map((questionId) => {
          const question = bank.questions.find((q) => q.id === questionId);
          if (!question)
            throw new AppError(
              "invalid_input",
              `Question ${questionId} does not belong to the selected bank revision.`,
            );
          return question;
        })
      : bank.questions;
    if (new Set(questions.map((q) => q.id)).size !== questions.length)
      throw new AppError(
        "invalid_input",
        "Question selection contains duplicate IDs.",
      );
    const resolvedTarget = await this.runtime.resolveTarget(input.target);
    const jevJudge =
      frozenJevJudge ??
      (input.jevJudge
        ? await this.jev.resolve(bank.bankId, input.jevJudge)
        : undefined);
    const judge =
      input.judge.enabled && input.judge.agent
        ? {
            ...input.judge,
            agent: await this.runtime.resolveAgent({
              ...input.judge.agent,
              tools: [],
            }),
          }
        : input.judge;
    validateTargetEvidence({
      observation: resolvedTarget.capabilities.observation,
      questionIds: questions.map((question) => question.id),
      evaluator: evaluator.settings,
      judge,
      jevJudge,
    });
    if (resolvedTarget.target.kind === "external")
      await this.runtime.externalTargets.retain(resolvedTarget.target);
    let admitted = false;
    const run = this.db.transaction(() => {
      if (key) {
        const existing = this.db.idempotent(key, requestHash);
        if (existing) {
          const prior = this.db.require("run", existing.id);
          commitResearchLaunch?.(prior);
          return prior;
        }
      }
      const manifest = {
        bank,
        evaluator,
        schemaVersion: 2 as const,
        target: resolvedTarget.target,
        targetCapabilities: resolvedTarget.capabilities,
        questions: questions.map((question) => ({
          ...question,
          evaluationGuidance: [
            question.evaluationGuidance,
            publicEvaluationGuidance(
              {
                ...evaluator.settings,
                ...evaluator.settings.questionOverrides[question.id],
              },
              question.expected,
            ),
          ]
            .filter(Boolean)
            .join("\n"),
        })),
        repetitions: input.repetitions,
        judge,
        ...(jevJudge ? { jevJudge } : {}),
        limits: input.limits,
        digest: "",
      };
      manifest.digest = digest(manifest);
      const runId = id("run");
      const resultIds: string[] = [];
      const record = this.db.insert("run", {
        id: runId,
        name: input.name,
        createdAt: now(),
        updatedAt: now(),
        status: "queued",
        intent: "run",
        manifest,
        activeDurationMs: 0,
        execution: {
          id: runId,
          resultIds,
          controller: researchSessionId ? "research" : "run",
          ...(researchSessionId
            ? { budgetResearchSessionId: researchSessionId }
            : {}),
          createdAt: now(),
        },
        ...(researchSessionId ? { researchSessionId } : {}),
      });
      for (let repetition = 1; repetition <= input.repetitions; repetition++)
        for (const question of questions)
          resultIds.push(
            this.db.insert("result", {
              id: id("result"),
              runId: record.id,
              questionId: question.id,
              repetition,
              status: "pending",
              attemptIds: [],
            }).id,
          );
      this.db.update("run", record);
      commitResearchLaunch?.(record);
      if (key) this.db.remember(key, requestHash, "run", record.id);
      this.db.append({
        runId: record.id,
        type: "run.created",
        message:
          "Run saved with frozen questions, configuration, and evaluator.",
      });
      admitted = true;
      return record;
    });
    if (admitted) this.schedule(run.id);
    return this.view(run.id);
  }
  async retryFailed(
    input: CommandInput<"runs.retry-failed">,
  ): Promise<RunView> {
    const source = this.db.require("run", input.runId);
    const key = `in-place-recovery-v1:${input.idempotencyKey}`;
    const hash = digest(input);
    const previous = this.db.idempotent(key, hash);
    if (previous) return this.view(previous.id);
    this.recoverySelection(
      source,
      input.resultIds,
      input.acknowledgeDuplicateWork ?? false,
      input.expectedExecutionId,
    );
    const sourceSequence = this.db.controlSequence({ runId: source.id });
    await this.resolveFrozenTarget(source);
    let admitted = false;
    this.db.transaction(() => {
      if (this.db.idempotent(key, hash)) return;
      const run = this.db.require("run", input.runId);
      if (
        digest(run) !== digest(source) ||
        this.db.controlSequence({ runId: run.id }) !== sourceSequence
      )
        throw new AppError(
          "conflict",
          "The Run changed while checking target readiness. Review its current state before starting new work.",
        );
      const selected = this.recoverySelection(
        run,
        input.resultIds,
        input.acknowledgeDuplicateWork ?? false,
        input.expectedExecutionId,
      );
      this.passes.freezeCurrent(run.id);
      const execution: RunExecution = {
        id: id("execution"),
        resultIds: selected.map((result) => result.id),
        controller: "run",
        createdAt: now(),
      };
      for (const result of selected)
        this.db.update("result", { ...result, status: "pending" });
      this.db.update("run", {
        ...run,
        execution,
        status: "queued",
        intent: "run",
        error: undefined,
        updatedAt: now(),
        ...(run.activeDurationMs === undefined
          ? { activeDurationIncomplete: true }
          : {}),
      });
      this.db.update("run", {
        ...this.db.require("run", run.id),
        selectedAssessmentPassId: this.passes.currentAutomaticId(run.id),
      });
      this.db.remember(key, hash, "run", run.id, {
        runId: run.id,
        executionId: execution.id,
        resultIds: execution.resultIds,
      });
      this.db.append({
        runId: run.id,
        type: "run.recovery.requested",
        message:
          "Recovering selected failed questions in this Run. Saved attempts and scores remain available.",
        data: { executionId: execution.id, resultIds: execution.resultIds },
      });
      admitted = true;
    });
    if (admitted) this.schedule(input.runId);
    return this.view(input.runId);
  }
  private recoverySelection(
    run: RunRecord,
    resultIds: string[] | undefined,
    acknowledgeDuplicateWork: boolean,
    expectedExecutionId?: string,
  ): ResultRecord[] {
    if (this.closing)
      throw new AppError("unavailable", "The engine is shutting down.");
    const ownershipReason = this.manualResearchReason(run);
    if (ownershipReason) throw new AppError("invalid_state", ownershipReason);
    if (
      expectedExecutionId !== undefined &&
      expectedExecutionId !== (run.execution?.id ?? run.id)
    )
      throw new AppError(
        "conflict",
        "This recovery action refers to an earlier execution. Refresh the Run before starting new work.",
      );
    if (
      run.intent === "cancel" ||
      this.jobs.has(run.id) ||
      !["completed", "failed", "halted", "paused"].includes(run.status)
    )
      throw new AppError(
        "invalid_state",
        "Stop active work before recovering failed questions. Cancelled Runs cannot resume.",
      );
    const answers = new AnswerSources(this.db);
    if (!answers.settled(run))
      throw new AppError(
        "invalid_state",
        "Wait for target and judge work to settle before recovering failed questions.",
      );
    const failed = this.db
      .list("result", { runId: run.id })
      .filter(
        (result) => result.status === "failed" && !answers.source(result),
      );
    const selected = resultIds
      ? resultIds.map((resultId) =>
          failed.find((result) => result.id === resultId),
        )
      : failed;
    if (
      !selected.length ||
      selected.some((result) => !result) ||
      new Set(selected.map((result) => result!.id)).size !== selected.length
    )
      throw new AppError(
        "invalid_input",
        "Select only failed unanswered results, without duplicates. Completed answers cannot be retried.",
      );
    const results = selected as ResultRecord[];
    this.checkDuplicateWork(run, results, acknowledgeDuplicateWork, true);
    return results;
  }
  private async resolveFrozenTarget(run: RunRecord): Promise<void> {
    const target = structuredClone(savedTarget(run.manifest));
    const expected = digest(target);
    const resolved = await this.runtime.resolveTarget(target);
    if (digest(resolved.target) !== expected)
      throw new AppError(
        "conflict",
        "The frozen target no longer resolves to the same configuration. Create a new Run to use changed settings.",
      );
  }
  private checkDuplicateWork(
    run: RunRecord,
    results: ResultRecord[],
    acknowledged: boolean,
    manualFailure = false,
  ): void {
    if (
      acknowledged ||
      !this.requiresDuplicateWork(run, results, manualFailure)
    )
      return;
    throw new AppError(
      "duplicate_work_acknowledgment_required",
      "Previous attempts might still have performed tool actions or remote work. Acknowledge possible duplicate work before continuing.",
    );
  }
  private requiresDuplicateWork(
    run: Pick<RunRecord, "id">,
    results: ResultRecord[],
    manualFailure = false,
  ): boolean {
    if (!results.some((result) => result.attemptIds.length)) return false;
    const external = this.db.runState(run.id).targetKind === "external";
    const attempts = new Map(
      this.db.attemptSummaries(run.id).map((attempt) => [attempt.id, attempt]),
    );
    return results.some((result) =>
      result.attemptIds.some((attemptId) => {
        const attempt = attempts.get(attemptId);
        if (!attempt)
          throw new AppError(
            "not_found",
            `attempt ${attemptId} was not found.`,
          );
        if (attempt.status === "completed") return false;
        if (external) return attempt.remoteCompletion !== "not-dispatched";
        return (
          manualFailure &&
          !["not-started", "no-side-effects"].includes(
            attempt.failure?.classification?.retrySafety ?? "unknown",
          )
        );
      }),
    );
  }
  private resumeEligibility(
    run: Omit<RunRecord, "manifest">,
  ): NonNullable<RunView["resumeEligibility"]> {
    const answers = new AnswerSources(this.db);
    const ownershipReason = this.manualResearchReason(run);
    const takeover = !ownershipReason && this.researchTakeover(run);
    const results = this.db
      .list("result", {
        runId: run.id,
        status: ["pending", "interrupted"],
        ...(run.execution && !run.execution.settledAt && !takeover
          ? { ids: run.execution.resultIds }
          : {}),
      })
      .filter((result) => !answers.source(result));
    const available =
      run.intent !== "cancel" &&
      !this.jobs.has(run.id) &&
      !ownershipReason &&
      answers.settled(run) &&
      ["paused", "halted", "failed"].includes(run.status) &&
      results.length > 0;
    return {
      available,
      resultIds: results.map((result) => result.id),
      requiresAcknowledgment: this.requiresDuplicateWork(run, results),
      ...(!available
        ? {
            reason:
              ownershipReason ??
              (run.intent === "cancel" || run.status === "cancelled"
                ? "Cancelled Runs cannot resume."
                : results.length
                  ? "Stop active work before resuming."
                  : "There are no unfinished questions in this execution. Recover failed questions explicitly."),
          }
        : {}),
    };
  }
  private manualResearchReason(
    run: Pick<RunRecord, "id" | "researchSessionId">,
  ): string | undefined {
    if (!run.researchSessionId) return undefined;
    const status = this.db.runState(run.id).researchStatus;
    return status && isTerminal(status)
      ? undefined
      : "Finish the research session before manually recovering its Run.";
  }
  private researchTakeover(
    run: Pick<RunRecord, "researchSessionId" | "execution">,
  ): boolean {
    return !!run.researchSessionId && run.execution?.controller !== "run";
  }
  controlOwner(runId: string): NonNullable<RunView["controllingJob"]> {
    const run = this.db.runState(runId);
    const parent =
      (run.execution?.controller === "research" ||
        (!run.execution && run.researchSessionId)) &&
      run.researchSessionId &&
      run.researchStatus &&
      !isTerminal(run.researchStatus)
        ? { id: run.researchSessionId, status: run.researchStatus }
        : undefined;
    const status = parent?.status ?? run.status;
    let actions = allowedActions(status);
    if (!parent) {
      const resume = this.resumeEligibility(run);
      actions = actions.filter(
        (action) => action !== "resume" || resume.available,
      );
      if (status === "failed" && resume.available) actions.push("resume");
    }
    return {
      kind: parent ? "research" : "run",
      id: parent?.id ?? run.id,
      status,
      allowedActions: actions,
    };
  }
  view(runId: string): RunView {
    const run = this.db.require("run", runId);
    return { run, ...this.project(run) };
  }
  private project(run: Omit<RunRecord, "manifest">): Omit<RunView, "run"> {
    const runId = run.id;
    const sources = new AnswerSources(this.db);
    const results = sources.results(runId);
    const physicalAttempts = sources.physicalAttempts(runId);
    const sourceRuns = [...new Set(physicalAttempts.values())];
    const controllingJob = this.controlOwner(runId);
    const actions = controllingJob.allowedActions;
    const failed = results.filter(
      (result) => result.status === "failed" && !result.answerSource,
    );
    const retryAvailable =
      run.intent !== "cancel" &&
      !this.jobs.has(runId) &&
      sources.settled(run) &&
      !this.manualResearchReason(run) &&
      ["completed", "failed", "halted", "paused"].includes(run.status) &&
      failed.length > 0;
    const retryEligibility = {
      available: retryAvailable,
      resultIds: failed.map((result) => result.id),
      requiresAcknowledgment: this.requiresDuplicateWork(run, failed, true),
      ...(!retryAvailable
        ? {
            reason:
              this.manualResearchReason(run) ??
              (run.status === "cancelled" || run.intent === "cancel"
                ? "Cancelled Runs cannot resume."
                : failed.length
                  ? "Stop active work before recovering failed questions."
                  : "There are no failed unanswered questions. Incorrect answers are not retried."),
          }
        : {}),
    };
    return {
      retryEligibility,
      resumeEligibility: this.resumeEligibility(run),
      results,
      attempts: sourceRuns
        .flatMap((sourceRunId) => this.usage.attempts(sourceRunId))
        .filter((attempt) => physicalAttempts.has(attempt.id)),
      jevAssessments: sourceRuns
        .flatMap((sourceRunId) => this.db.jevSummaries(sourceRunId))
        .filter((assessment) => physicalAttempts.has(assessment.attemptId)),
      reviews: this.db.list("review", { runId }),
      allowedActions: actions,
      controllingJob,
      progress: {
        completed: results.filter((r) => r.answerSource).length,
        failed: results.filter((r) => r.status === "failed" && !r.answerSource)
          .length,
        total: results.length,
      },
    };
  }
  observe(runId: string): RunObservation {
    const {
      targetKind: _kind,
      targetHarness: _harness,
      researchStatus: _researchStatus,
      ...run
    } = this.db.runState(runId);
    return { run, ...this.project(run) };
  }
  private readAttempt(
    runId: string,
    attemptId: string,
    expectedEvidenceHash?: string,
  ) {
    this.db.require("run", runId);
    const { attempt } = new AnswerSources(this.db).authorize(runId, attemptId);
    if (
      expectedEvidenceHash !== undefined &&
      (attempt.status !== "completed" ||
        attempt.evidenceHash !== expectedEvidenceHash ||
        !attempt.output ||
        digest(attempt.output) !== expectedEvidenceHash)
    )
      throw new AppError(
        "conflict",
        "This attempt does not match the selected sealed answer.",
      );
    return attempt;
  }
  answer(input: CommandInput<"runs.answer">) {
    const attempt = this.readAttempt(
      input.runId,
      input.attemptId,
      input.expectedEvidenceHash,
    );
    return {
      attemptId: attempt.id,
      evidenceHash: input.expectedEvidenceHash,
      answer: attempt.output!.answer,
    };
  }
  attempt(
    runId: string,
    attemptId: string,
    expectedEvidenceHash?: string,
  ): AttemptDetail {
    const attempt = this.readAttempt(runId, attemptId, expectedEvidenceHash);
    const assessments = this.db.attemptAssessments(attempt.runId, attemptId);
    if (
      !assessments.some(
        (item) => item.scoreSetId === `original_${attempt.runId}`,
      )
    ) {
      const assessment = this.db
        .list("assessment", { resultId: attempt.resultId })
        .find((item) => item.attemptId === attempt.id);
      if (assessment)
        assessments.unshift({
          scoreSetId: `original_${attempt.runId}`,
          evaluator: this.db.require("run", attempt.runId).manifest.evaluator,
          assessment,
        });
    }
    const { adapterCheckpoint: _checkpoint, ...publicAttempt } = attempt;
    return {
      attempt: publicAttempt,
      jevAssessments: this.db
        .jevSummaries(attempt.runId)
        .filter((value) => value.attemptId === attemptId),
      assessments,
    };
  }
  async control(
    input: CommandInput<"runs.control">,
    prepareResearchControl?: () => ResearchControlAdmission | undefined,
  ): Promise<RunView> {
    const {
      runId: requestedRunId,
      action,
      idempotencyKey,
      expectedExecutionId,
    } = input;
    const acknowledgeDuplicateWork = input.acknowledgeDuplicateWork ?? false;
    const key = idempotencyKey
      ? `in-place-${action}-v1:${idempotencyKey}`
      : undefined;
    const hash = digest({
      runId: requestedRunId,
      action,
      acknowledgeDuplicateWork,
      expectedExecutionId,
    });
    // The original request owns its receipt, even after control ownership changes.
    if (key && this.db.idempotent(key, hash)) return this.view(requestedRunId);
    const requestedRun = this.db.require("run", requestedRunId);
    const requestedSequence = this.db.controlSequence({
      runId: requestedRunId,
    });
    const checkRequest = () => {
      const current = this.db.require("run", requestedRunId);
      if (
        expectedExecutionId !== undefined &&
        expectedExecutionId !== (current.execution?.id ?? current.id)
      )
        throw new AppError(
          "conflict",
          "This control action refers to an earlier execution. Refresh the Run before starting new work.",
        );
      if (
        digest(current) !== digest(requestedRun) ||
        this.db.controlSequence({ runId: requestedRunId }) !== requestedSequence
      )
        throw new AppError(
          "conflict",
          "The requested Run changed while preparing its control action.",
        );
    };
    checkRequest();
    const research = prepareResearchControl?.();
    const remember = () => {
      if (key) {
        const execution = this.db.require("run", requestedRunId).execution;
        this.db.remember(key, hash, "run", requestedRunId, {
          runId: requestedRunId,
          executionId: execution?.id ?? requestedRunId,
          ...(execution ? { resultIds: execution.resultIds } : {}),
        });
      }
    };
    if (research && !research.targetRunId) {
      let admitted = false;
      this.db.transaction(() => {
        if (key && this.db.idempotent(key, hash)) return;
        checkRequest();
        research.commit();
        remember();
        admitted = true;
      });
      if (admitted) research.activate();
      return this.view(requestedRunId);
    }
    const runId = research?.targetRunId ?? requestedRunId;
    const run = this.db.require("run", runId);
    if (action === "resume") {
      if (
        !idempotencyKey &&
        ["queued", "running"].includes(run.status) &&
        this.jobs.has(runId)
      ) {
        if (research)
          this.db.transaction(() => {
            checkRequest();
            if (digest(this.db.require("run", runId)) !== digest(run))
              throw new AppError(
                "conflict",
                "The Run changed while preparing its control action.",
              );
            research.commit();
          });
        research?.activate();
        return this.view(requestedRunId);
      }
      const prepare = (current: RunRecord) => {
        if (this.closing)
          throw new AppError("unavailable", "The engine is shutting down.");
        const ownershipReason = !research
          ? this.manualResearchReason(current)
          : undefined;
        if (ownershipReason)
          throw new AppError("invalid_state", ownershipReason);
        if (
          current.intent === "cancel" ||
          this.jobs.has(runId) ||
          !["paused", "halted", "failed"].includes(current.status)
        )
          throw new AppError(
            "invalid_state",
            `Cannot resume a ${current.status} Run.`,
          );
        const answers = new AnswerSources(this.db);
        if (!answers.settled(current))
          throw new AppError(
            "invalid_state",
            "Wait for target and judge work to settle before resuming.",
          );
        const takeover = !research && this.researchTakeover(current);
        const results = this.db
          .list("result", {
            runId,
            status: ["pending", "interrupted"],
            ...(current.execution && !current.execution.settledAt && !takeover
              ? { ids: current.execution.resultIds }
              : {}),
          })
          .filter((result) => !answers.source(result));
        if (!results.length)
          throw new AppError(
            "invalid_state",
            "There are no unfinished questions in this execution. Recover failed questions explicitly.",
          );
        this.checkDuplicateWork(current, results, acknowledgeDuplicateWork);
        return results;
      };
      prepare(run);
      const sourceSequence = this.db.controlSequence({ runId });
      await this.resolveFrozenTarget(run);
      let admitted = false;
      this.db.transaction(() => {
        if (key && this.db.idempotent(key, hash)) return;
        checkRequest();
        const current = this.db.require("run", runId);
        if (
          digest(current) !== digest(run) ||
          this.db.controlSequence({ runId }) !== sourceSequence
        )
          throw new AppError(
            "conflict",
            "The Run changed while checking target readiness. Review its current state before starting new work.",
          );
        const results = prepare(current);
        research?.commit();
        const continuation =
          !!current.execution?.settledAt ||
          (!research && this.researchTakeover(current));
        if (continuation) this.passes.freezeCurrent(runId);
        const execution: RunExecution = continuation
          ? {
              id: id("execution"),
              resultIds: results.map((result) => result.id),
              controller: "run",
              createdAt: now(),
            }
          : {
              ...(current.execution ?? {
                id: current.id,
                resultIds: this.db
                  .list("result", { runId })
                  .map((result) => result.id),
                controller: current.researchSessionId ? "research" : "run",
                ...(current.researchSessionId
                  ? { budgetResearchSessionId: current.researchSessionId }
                  : {}),
                createdAt: current.createdAt,
              }),
              stopReason: undefined,
            };
        this.db.update("run", {
          ...current,
          execution,
          status: "queued",
          intent: "run",
          error: undefined,
          updatedAt: now(),
          ...(current.activeDurationMs === undefined
            ? { activeDurationIncomplete: true }
            : {}),
        });
        if (continuation)
          this.db.update("run", {
            ...this.db.require("run", runId),
            selectedAssessmentPassId: this.passes.currentAutomaticId(runId),
          });
        remember();
        this.db.append({
          runId,
          type: "run.control.requested",
          message: "Resume requested.",
          data: { action, executionId: execution.id },
        });
        admitted = true;
      });
      if (admitted) {
        this.schedule(runId);
        research?.activate();
      }
      return this.view(requestedRunId);
    }
    let admitted = false;
    this.db.transaction(() => {
      if (key && this.db.idempotent(key, hash)) return;
      checkRequest();
      const current = this.db.require("run", runId);
      if (digest(current) !== digest(run))
        throw new AppError(
          "conflict",
          "The Run changed while preparing its control action.",
        );
      const transition = controlTransition(current.status, action);
      research?.commit();
      this.db.update("run", { ...current, ...transition, updatedAt: now() });
      this.db.append({
        runId,
        type: "run.control.requested",
        message: `${action[0]!.toUpperCase()}${action.slice(1)} requested.`,
        data: { action },
      });
      remember();
      admitted = true;
    });
    if (admitted && (action === "halt" || action === "cancel"))
      for (const controller of this.controllers.get(runId)?.values() ?? [])
        controller.abort(new Error(action));
    if (admitted) {
      if (!this.jobs.has(runId)) this.settleIntent(runId);
      research?.activate();
    }
    return this.view(requestedRunId);
  }
  private schedule(runId: string): void {
    if (this.jobs.has(runId) || this.closing) return;
    const job = this.drive(runId)
      .catch((error: unknown) => {
        this.db.transaction(() => {
          const run = this.db.require("run", runId);
          const transition = faultTransition(run, true);
          const finishedAt = now();
          const elapsed = run.execution?.activeSegmentStartedAt
            ? Math.max(
                0,
                Date.parse(finishedAt) -
                  Date.parse(run.execution.activeSegmentStartedAt),
              )
            : 0;
          this.db.update("run", {
            ...run,
            ...transition,
            error: errorMessage(error),
            updatedAt: finishedAt,
            ...(run.activeDurationMs !== undefined
              ? { activeDurationMs: run.activeDurationMs + elapsed }
              : {}),
            ...(run.execution
              ? {
                  execution: {
                    ...run.execution,
                    activeSegmentStartedAt: undefined,
                    settledAt: finishedAt,
                    stopReason:
                      transition.status === "cancelled"
                        ? "cancelled"
                        : "failed",
                  },
                }
              : {}),
          });
          this.passes.sealCurrent(runId);
          this.db.append({
            runId,
            type: `run.${transition.status}`,
            message: errorMessage(error),
          });
        });
      })
      .finally(() => {
        this.jobs.delete(runId);
        this.controllers.delete(runId);
        this.admissionLimits.delete(runId);
        this.executingCounts.delete(runId);
        this.admissionWaiters.delete(runId);
      });
    this.jobs.set(runId, job);
  }
  private async drive(runId: string): Promise<void> {
    const run = this.db.require("run", runId);
    if (isTerminal(run.status) || run.intent !== "run")
      return this.settleIntent(runId);
    this.db.update("run", {
      ...run,
      status: "running",
      updatedAt: now(),
      ...(run.execution
        ? {
            execution: {
              ...run.execution,
              activeSegmentStartedAt: now(),
              stopReason: undefined,
            },
          }
        : { activeDurationIncomplete: true }),
    });
    this.db.append({
      runId,
      type: "run.started",
      message: "Evaluation started.",
    });
    this.controllers.set(runId, new Map());
    this.admissionLimits.set(runId, run.manifest.limits.concurrency);
    const workers = new Set<Promise<void>>();
    const failures: unknown[] = [];
    const startWorker = (index: number) => {
      const task = worker(index)
        .catch((error: unknown) => {
          failures.push(error);
        })
        .finally(() => workers.delete(task));
      workers.add(task);
    };
    const worker = async (workerIndex: number) => {
      while (!this.closing && this.db.require("run", runId).intent === "run") {
        if (workerIndex >= (this.admissionLimits.get(runId) ?? 1)) break;
        const result = this.db.list("result", {
          runId,
          status: ["pending", "interrupted"],
          ...(run.execution ? { ids: run.execution.resultIds } : {}),
          limit: 1,
        })[0];
        if (!result) break;
        if (
          run.execution?.budgetResearchSessionId ??
          (!run.execution ? run.researchSessionId : undefined)
        ) {
          const session = this.db.require(
            "research",
            (run.execution?.budgetResearchSessionId ?? run.researchSessionId)!,
          );
          const reason = checkResearchBudget(this.db, session, 1, runId);
          if (reason) {
            this.requestFaultStop(runId, `Research budget: ${reason}`);
            this.db.append({
              runId,
              type: "run.budget.exhausted",
              message: reason,
            });
            break;
          }
        }
        await this.executeResult(run, result, () => startWorker(0));
      }
    };
    for (let index = 0; index < run.manifest.limits.concurrency; index++)
      startWorker(index);
    while (workers.size) await Promise.all([...workers]);
    if (failures.length) throw failures[0];
    this.settleIntent(runId);
  }
  private settleIntent(runId: string): void {
    const run = this.db.require("run", runId);
    if (isTerminal(run.status)) return;
    const unfinished =
      this.db.list("result", {
        runId,
        status: ["pending", "running", "interrupted"],
        limit: 1,
      }).length > 0;
    const scopedUnfinished =
      this.db.list("result", {
        runId,
        status: ["pending", "running", "interrupted"],
        ...(run.execution ? { ids: run.execution.resultIds } : {}),
        limit: 1,
      }).length > 0;
    const fatalStop = run.execution?.stopReason === "failed";
    const status = settlementStatus(run, unfinished, fatalStop);
    this.db.transaction(() => {
      const finishedAt = now();
      const elapsed = run.execution?.activeSegmentStartedAt
        ? Math.max(
            0,
            Date.parse(finishedAt) -
              Date.parse(run.execution.activeSegmentStartedAt),
          )
        : 0;
      const settled = !scopedUnfinished || status === "cancelled";
      this.db.update("run", {
        ...run,
        status,
        updatedAt: finishedAt,
        ...(run.activeDurationMs !== undefined
          ? { activeDurationMs: run.activeDurationMs + elapsed }
          : {}),
        ...(run.execution
          ? {
              execution: {
                ...run.execution,
                activeSegmentStartedAt: undefined,
                ...(settled ? { settledAt: finishedAt } : {}),
                stopReason:
                  status === "halted" &&
                  run.intent === "run" &&
                  unfinished &&
                  !scopedUnfinished
                    ? "outside-scope-unfinished"
                    : fatalStop && status !== "cancelled"
                      ? "failed"
                      : status,
              },
            }
          : {}),
      });
      if (settled) this.passes.sealCurrent(runId);
      this.db.append({
        runId,
        type: `run.${status}`,
        message: `Run ${status}.`,
      });
    });
  }
  private requestFaultStop(runId: string, error: string): void {
    const current = this.db.require("run", runId);
    this.db.update("run", {
      ...current,
      ...faultTransition(current),
      error,
      updatedAt: now(),
      ...(current.execution
        ? { execution: { ...current.execution, stopReason: "failed" } }
        : {}),
    });
  }
  private async acquireExecution(
    runId: string,
    resultId: string,
  ): Promise<boolean> {
    const controller = new AbortController(),
      key = `admission-${resultId}`;
    this.controllers.get(runId)!.set(key, controller);
    try {
      while (
        (this.executingCounts.get(runId) ?? 0) >=
        (this.admissionLimits.get(runId) ?? 1)
      ) {
        if (
          controller.signal.aborted ||
          this.closing ||
          this.db.require("run", runId).intent !== "run"
        )
          return false;
        await new Promise<void>((resolve) => {
          const waiters =
            this.admissionWaiters.get(runId) ?? new Set<() => void>();
          const wake = () => {
            waiters.delete(wake);
            controller.signal.removeEventListener("abort", wake);
            resolve();
          };
          waiters.add(wake);
          this.admissionWaiters.set(runId, waiters);
          controller.signal.addEventListener("abort", wake, { once: true });
        });
      }
      if (
        controller.signal.aborted ||
        this.closing ||
        this.db.require("run", runId).intent !== "run"
      )
        return false;
      this.executingCounts.set(
        runId,
        (this.executingCounts.get(runId) ?? 0) + 1,
      );
      return true;
    } finally {
      this.controllers.get(runId)?.delete(key);
    }
  }
  private releaseExecution(runId: string): void {
    this.executingCounts.set(
      runId,
      Math.max(0, (this.executingCounts.get(runId) ?? 1) - 1),
    );
    for (const wake of this.admissionWaiters.get(runId) ?? []) wake();
  }
  private async executeResult(
    run: RunRecord,
    result: ResultRecord,
    onRetryWaiting: () => void,
  ): Promise<void> {
    let executionAttempt = 0;
    for (;;) {
      this.db.update("result", {
        ...this.db.require("result", result.id),
        status: "running",
      });
      if (!(await this.acquireExecution(run.id, result.id))) {
        this.db.update("result", {
          ...this.db.require("result", result.id),
          status: "interrupted",
        });
        return;
      }
      try {
        const budgetSessionId =
          run.execution?.budgetResearchSessionId ??
          (!run.execution ? run.researchSessionId : undefined);
        const sessionAtAdmission = budgetSessionId
          ? this.db.require("research", budgetSessionId)
          : undefined;
        const budgetAtAdmission = sessionAtAdmission
          ? checkResearchBudget(this.db, sessionAtAdmission, 1, run.id)
          : undefined;
        if (
          this.closing ||
          this.db.require("run", run.id).intent !== "run" ||
          budgetAtAdmission
        ) {
          this.db.update("result", {
            ...this.db.require("result", result.id),
            status: "interrupted",
          });
          if (budgetAtAdmission)
            await this.control({ runId: run.id, action: "halt" });
          return;
        }
        executionAttempt++;
        await this.executeAttempt(run, result);
      } finally {
        this.releaseExecution(run.id);
      }
      const latest = this.db.require("result", result.id);
      const attempt = this.db.require("attempt", latest.attemptIds.at(-1)!);
      const classification = attempt.failure?.classification;
      if (latest.status !== "failed" || !classification) return;
      const delay = automaticRetryDelay(
        classification,
        executionAttempt,
        savedTarget(run.manifest).kind,
      );
      if (
        delay === undefined ||
        this.closing ||
        this.db.require("run", run.id).intent !== "run"
      )
        return;
      const budgetSessionId =
        run.execution?.budgetResearchSessionId ??
        (!run.execution ? run.researchSessionId : undefined);
      const session = budgetSessionId
        ? this.db.require("research", budgetSessionId)
        : undefined;
      const exhausted = session
        ? checkResearchBudget(this.db, session, 1, run.id)
        : undefined;
      if (exhausted) {
        await this.control({ runId: run.id, action: "halt" });
        return;
      }
      this.admissionLimits.set(
        run.id,
        Math.max(1, Math.floor((this.admissionLimits.get(run.id) ?? 1) / 2)),
      );
      this.db.update("result", { ...latest, status: "running" });
      this.db.append({
        runId: run.id,
        attemptId: attempt.id,
        type: "question.retry.waiting",
        message:
          "Provider capacity is temporarily unavailable. Waiting before a safe retry; concurrency has been reduced.",
        data: {
          delayMs: delay,
          nextAttempt: attempt.number + 1,
          concurrency: this.admissionLimits.get(run.id)!,
        },
      });
      const controller = new AbortController();
      this.controllers.get(run.id)!.set(attempt.id, controller);
      try {
        // Backoff releases provider capacity and the question worker independently.
        onRetryWaiting();
        await wait(delay, undefined, { signal: controller.signal });
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        this.controllers.get(run.id)?.delete(attempt.id);
      }
      if (
        controller.signal.aborted ||
        this.closing ||
        this.db.require("run", run.id).intent !== "run"
      ) {
        this.db.update("result", {
          ...this.db.require("result", result.id),
          status: "interrupted",
        });
        return;
      }
      const currentSession = budgetSessionId
        ? this.db.require("research", budgetSessionId)
        : undefined;
      if (
        currentSession &&
        checkResearchBudget(this.db, currentSession, 1, run.id)
      ) {
        this.db.update("result", {
          ...this.db.require("result", result.id),
          status: "interrupted",
        });
        await this.control({ runId: run.id, action: "halt" });
        return;
      }
      result = this.db.require("result", result.id);
    }
  }
  private async executeAttempt(
    run: RunRecord,
    result: ResultRecord,
  ): Promise<void> {
    const question = run.manifest.questions.find(
      (q) => q.id === result.questionId,
    )!;
    const attempt: AttemptRecord = {
      id: id("attempt"),
      resultId: result.id,
      runId: run.id,
      executionId: run.execution?.id ?? run.id,
      ...((run.execution?.budgetResearchSessionId ??
      (!run.execution ? run.researchSessionId : undefined))
        ? {
            budgetResearchSessionId: (run.execution?.budgetResearchSessionId ??
              run.researchSessionId)!,
          }
        : {}),
      number: result.attemptIds.length + 1,
      startedAt: now(),
      status: "running",
      ...(savedTarget(run.manifest).kind === "external"
        ? { remoteCompletion: "not-dispatched" as const }
        : {}),
    };
    this.db.transaction(() => {
      this.db.insert("attempt", attempt);
      this.db.update("result", {
        ...result,
        status: "running",
        attemptIds: [...result.attemptIds, attempt.id],
      });
      this.db.append({
        runId: run.id,
        attemptId: attempt.id,
        type: "question.started",
        message: question.text,
        data: {
          resultId: result.id,
          questionId: question.id,
          repetition: result.repetition,
        },
      });
    });
    const controller = new AbortController();
    this.controllers.get(run.id)!.set(attempt.id, controller);
    const artifactDirectory = join(
      this.directory,
      "artifacts",
      run.id,
      attempt.id,
    );
    let completed = false;
    let acceptingEvents = true;
    let toolActivity = false;
    try {
      await mkdir(artifactDirectory, { recursive: true });
      const parent = attempt.budgetResearchSessionId
        ? this.db.require("research", attempt.budgetResearchSessionId)
        : undefined;
      const timeoutMs = parent
        ? Math.max(
            100,
            Math.min(
              run.manifest.limits.timeoutMs,
              Date.parse(parent.createdAt) +
                parent.configuration.maxDurationMs -
                Date.now(),
            ),
          )
        : run.manifest.limits.timeoutMs;
      const output = await this.invocations.execute({
        attemptId: attempt.id,
        target: savedTarget(run.manifest),
        runId: run.id,
        repetition: result.repetition,
        question: {
          id: question.id,
          text: question.text,
          tags: question.tags,
          ...(question.context ? { context: question.context } : {}),
          ...(question.evaluationGuidance
            ? { evaluationGuidance: question.evaluationGuidance }
            : {}),
          ...(question.answerFormat
            ? { answerFormat: question.answerFormat }
            : {}),
        },
        artifactDirectory,
        timeoutMs,
        maxOutputBytes: run.manifest.limits.maxOutputBytes,
        signal: controller.signal,
        checkpoint: async (value) => {
          controller.signal.throwIfAborted();
          this.db.update("attempt", {
            ...this.db.require("attempt", attempt.id),
            adapterCheckpoint: value,
            remoteCompletion: "unknown",
          });
        },
        onEvent: (event) => {
          if (event.type.startsWith("tool.")) toolActivity = true;
          if (
            acceptingEvents &&
            this.db.require("result", result.id).attemptIds.at(-1) ===
              attempt.id
          )
            this.db.append({ runId: run.id, attemptId: attempt.id, ...event });
        },
      });
      acceptingEvents = false;
      targetOutputSchema.parse(output);
      const serialized = JSON.stringify(output);
      if (Buffer.byteLength(serialized) > run.manifest.limits.maxOutputBytes)
        throw new AppError(
          "evidence_limit",
          "Target evidence exceeds the configured output limit.",
        );
      await writeFile(
        join(artifactDirectory, "answer.pending.json"),
        serialized,
        { encoding: "utf8", flag: "wx" },
      );
      await rename(
        join(artifactDirectory, "answer.pending.json"),
        join(artifactDirectory, "answer.json"),
      );
      const sealed: AttemptRecord = {
        ...this.db.require("attempt", attempt.id),
        ...(savedTarget(run.manifest).kind === "external"
          ? { remoteCompletion: "observed" as const }
          : {}),
        status: "completed",
        finishedAt: now(),
        output,
        evidenceHash: digest(output),
      };
      this.db.transaction(() => {
        this.db.update("attempt", sealed);
        this.db.update("result", {
          ...this.db.require("result", result.id),
          status: "completed",
          completedAttemptId: attempt.id,
        });
        this.db.append({
          runId: run.id,
          attemptId: attempt.id,
          type: "answer.completed",
          message: output.text,
          data: { answer: output.answer, evidenceHash: sealed.evidenceHash! },
        });
      });
      completed = true;
      if (output.cleanup === "unavailable") {
        this.requestFaultStop(
          run.id,
          "The answer is saved, but target resource cleanup requires recovery before more work.",
        );
        this.db.append({
          runId: run.id,
          attemptId: attempt.id,
          type: "target.cleanup.unavailable",
          message:
            "The answer is saved. Target resource cleanup is unresolved; restart the engine to recover.",
        });
      }
      const assessment = await this.evaluation.assess(run, result, sealed);
      if (run.manifest.judge.enabled)
        Object.assign(
          assessment,
          await new LlmJudgeService(this.db, this.runtime).evaluate({
            runId: run.id,
            attemptId: attempt.id,
            configuration: run.manifest.judge,
            artifactDirectory: join(artifactDirectory, "judge"),
            signal: controller.signal,
            original: true,
          }),
        );
      this.db.insert(
        "assessment",
        { ...assessment, runId: run.id, id: id("assessment") },
        true,
      );
      if (run.manifest.jevJudge) {
        const parent = attempt.budgetResearchSessionId
          ? this.db.require("research", attempt.budgetResearchSessionId)
          : undefined;
        const budget = parent
          ? checkResearchBudget(this.db, parent, 0, run.id)
          : undefined;
        await this.jev.evaluate(
          run.id,
          attempt.id,
          run.manifest.jevJudge,
          "original",
          true,
          controller.signal,
          budget ? { code: "budget_exhausted", message: budget } : undefined,
        );
      }
      this.db.append({
        runId: run.id,
        attemptId: attempt.id,
        type: "evaluation.completed",
        message: assessment.deterministic.explanation,
        data: {
          status: assessment.deterministic.status,
          ...(assessment.judge ? { judge: assessment.judge.verdict } : {}),
          ...(assessment.judgeError
            ? { judgeError: assessment.judgeError }
            : {}),
        },
      });
    } catch (error) {
      if (completed) throw error;
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "engine_failure";
      const interrupted =
        controller.signal.aborted && code !== "cleanup_failed";
      const classification = classifyExecutionFailure(error);
      if (toolActivity) classification.retrySafety = "unsafe";
      const status = interrupted ? "interrupted" : "failed";
      const transport =
        error && typeof error === "object" && "evidence" in error
          ? jsonSchema.safeParse(error.evidence)
          : undefined;
      const remoteCompletion =
        error &&
        typeof error === "object" &&
        "remoteCompletion" in error &&
        ["not-dispatched", "unknown"].includes(String(error.remoteCompletion))
          ? (error.remoteCompletion as "not-dispatched" | "unknown")
          : undefined;
      this.db.transaction(() => {
        this.db.update("attempt", {
          ...this.db.require("attempt", attempt.id),
          status,
          finishedAt: now(),
          error: errorMessage(error),
          failure: {
            code,
            classification,
            ...(transport?.success ? { transport: transport.data } : {}),
          },
          ...(remoteCompletion ? { remoteCompletion } : {}),
        });
        this.db.update("result", {
          ...this.db.require("result", result.id),
          status,
        });
        this.db.append({
          runId: run.id,
          attemptId: attempt.id,
          type: `question.${status}`,
          message: errorMessage(error),
        });
      });
      const configurationBlocked = ["authentication", "configuration"].includes(
        classification.category,
      );
      if (
        !interrupted &&
        (configurationBlocked ||
          (!(
            classification.transient &&
            ["rate-limit", "provider-capacity"].includes(
              classification.category,
            )
          ) &&
            ![
              "target_failure",
              "timeout",
              "output_limit",
              "evidence_failure",
              "evidence_limit",
              "http_error",
              "protocol_error",
              "request_too_large",
              "response_too_large",
              "invalid_response",
              "answer_mapping",
              "transport_error",
              "invalid_json",
              "answer_missing",
              "submission_rejected",
              "tool_rejected",
            ].includes(code)))
      ) {
        this.requestFaultStop(run.id, errorMessage(error));
        for (const active of this.controllers.get(run.id)?.values() ?? [])
          active.abort(new Error("A fatal execution failure stopped the run."));
        if (!configurationBlocked) throw error;
      }
    } finally {
      acceptingEvents = false;
      this.controllers.get(run.id)?.delete(attempt.id);
    }
  }
  exportAgent(runId: string): Json {
    const run = this.db.require("run", runId);
    const agent: AgentConfig = managedAgent(savedTarget(run.manifest));
    return {
      schemaVersion: 1,
      exportedFrom: { runId, manifestDigest: run.manifest.digest },
      agent: {
        harness: agent.harness,
        model: agent.model,
        systemPrompt: agent.systemPrompt,
        settings: agent.settings,
        tools: agent.tools,
        connections: agent.connections.map((binding) => {
          const exported = { ...binding };
          delete exported.credentialBinding;
          return {
            ...exported,
            credentials: Object.fromEntries(
              (binding.credentialFields ?? []).map((field) => [
                field,
                "${" +
                  `${binding.provider.toUpperCase()}_${field.toUpperCase()}` +
                  "}",
              ]),
            ),
          };
        }),
      },
    } as Json;
  }
  exportTarget(runId: string): Json {
    const run = this.db.require("run", runId);
    const target = savedTarget(run.manifest);
    if (target.kind === "managed") return this.exportAgent(runId);
    const configuration = JSON.parse(
      JSON.stringify(target.configuration),
      (key, value: unknown) =>
        key === "credentialReference" ? "${EXTERNAL_AGENT_CREDENTIAL}" : value,
    ) as Json;
    return {
      schemaVersion: 2,
      exportedFrom: { runId, manifestDigest: run.manifest.digest },
      scope: "external-invocation",
      target: { ...target, configuration },
    };
  }
  async waitFor(runId: string): Promise<void> {
    await this.jobs.get(runId);
  }
  async sample(
    input: CommandInput<"targets.sample">,
    signal: AbortSignal = new AbortController().signal,
  ) {
    signal.throwIfAborted();
    const { target } = await this.runtime.resolveTarget(input.target);
    if (target.kind === "external")
      await this.runtime.externalTargets.retain(target);
    signal.throwIfAborted();
    const attemptId = id("sample");
    const artifactDirectory = join(
      this.directory,
      "artifacts",
      "samples",
      attemptId,
    );
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(
      join(artifactDirectory, "sample.json"),
      JSON.stringify({
        schemaVersion: 1,
        target,
        question: publicQuestionSchema.parse(input.question),
        createdAt: now(),
        timeoutMs: input.timeoutMs ?? 120000,
      }),
      { mode: 0o600, flag: "wx" },
    );
    const output = await this.invocations.execute({
      target,
      runId: "sample",
      attemptId,
      repetition: 1,
      question: publicQuestionSchema.parse(input.question),
      timeoutMs: input.timeoutMs ?? 120000,
      maxOutputBytes: 4 * 1024 * 1024,
      artifactDirectory,
      signal,
      onEvent() {},
      checkpoint: async () => {},
    });
    await writeFile(
      join(artifactDirectory, "answer.json"),
      JSON.stringify(output),
      { mode: 0o600, flag: "wx" },
    );
    if (output.cleanup === "unavailable")
      throw new AppError(
        "cleanup_failed",
        "The sample answer is saved, but resource cleanup requires recovery before more work.",
      );
    return output;
  }
  async waitForIdle(): Promise<void> {
    while (this.jobs.size) await Promise.all([...this.jobs.values()]);
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const runId of this.jobs.keys()) {
      const run = this.db.require("run", runId);
      if (!isTerminal(run.status) && run.intent !== "cancel")
        await this.control({ runId, action: "halt" });
    }
    await this.waitForIdle();
  }
}
