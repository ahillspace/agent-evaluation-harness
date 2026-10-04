import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  judgeVerdictSchema,
  targetOutputSchema,
  type AgentConfig,
  type AttemptRecord,
  type Control,
  type Json,
  type LaunchInput,
  type ResultRecord,
  type RunRecord,
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
} from "../domain/lifecycle.js";
import { Database } from "../storage/database.js";
import { EvaluationService } from "./evaluations.js";
import { checkResearchBudget } from "./research-budget.js";
import { JevService } from "./jev.js";
import { savedTarget, managedAgent } from "../contracts/targets.js";
import { TargetInvocations } from "./target-invocations.js";
import { validateTargetEvidence } from "./evidence-requirements.js";

export class RunService {
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly controllers = new Map<
    string,
    Map<string, AbortController>
  >();
  private closing = false;
  private readonly invocations: TargetInvocations;
  constructor(
    private readonly db: Database,
    private readonly runtime: RuntimePort,
    private readonly evaluation: EvaluationService,
    private readonly directory: string,
    private readonly jev: JevService,
  ) {
    this.invocations = new TargetInvocations(directory, runtime);
  }
  async recover(): Promise<void> {
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
        const status =
          run.intent === "cancel"
            ? "cancelled"
            : run.intent === "pause"
              ? "paused"
              : "halted";
        this.db.update("run", {
          ...run,
          status,
          intent:
            run.intent === "cancel"
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
  }
  async launch(
    input: LaunchInput,
    researchSessionId?: string,
    frozenJevJudge?: FrozenJevJudge,
  ): Promise<RunView> {
    if (this.closing)
      throw new AppError("unavailable", "The engine is shutting down.");
    const requestHash = digest(input);
    const key = input.idempotencyKey
      ? `run:${input.idempotencyKey}`
      : undefined;
    if (key) {
      const existing = this.db.idempotent(key, requestHash);
      if (existing) return this.view(existing.id);
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
    if (
      input.target.kind === "external" &&
      (input.limits.timeoutMs < 1000 || input.limits.timeoutMs > 600_000)
    )
      throw new AppError(
        "invalid_input",
        "External request timeout must be between 1 second and 10 minutes.",
      );
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
    const run = this.db.transaction(() => {
      if (key) {
        const existing = this.db.idempotent(key, requestHash);
        if (existing) return this.db.require("run", existing.id);
      }
      const manifest = {
        bank,
        evaluator,
        schemaVersion: 2 as const,
        target: resolvedTarget.target,
        targetCapabilities: resolvedTarget.capabilities,
        questions,
        repetitions: input.repetitions,
        judge,
        ...(jevJudge ? { jevJudge } : {}),
        limits: input.limits,
        digest: "",
      };
      manifest.digest = digest(manifest);
      const record = this.db.insert("run", {
        id: id("run"),
        name: input.name,
        createdAt: now(),
        updatedAt: now(),
        status: "queued",
        intent: "run",
        manifest,
        ...(researchSessionId ? { researchSessionId } : {}),
      });
      for (let repetition = 1; repetition <= input.repetitions; repetition++)
        for (const question of questions)
          this.db.insert("result", {
            id: id("result"),
            runId: record.id,
            questionId: question.id,
            repetition,
            status: "pending",
            attemptIds: [],
          });
      if (key) this.db.remember(key, requestHash, "run", record.id);
      this.db.append({
        runId: record.id,
        type: "run.created",
        message:
          "Run saved with frozen questions, configuration, and evaluator.",
      });
      return record;
    });
    this.schedule(run.id);
    return this.view(run.id);
  }
  view(runId: string, cursor = 0): RunView {
    const run = this.db.require("run", runId);
    const results = this.db.list("result", { runId });
    const events = this.db.events({ runId }, cursor, {
      summary: true,
      limit: 200,
    });
    const scoreSets = this.evaluation.summaries(runId);
    const parent = run.researchSessionId
      ? this.db.get("research", run.researchSessionId)
      : undefined;
    const actions = allowedActions(parent?.status ?? run.status);
    return {
      run,
      results,
      attempts: this.db.attemptSummaries(runId),
      scoreSets,
      jevAssessments: this.db.jevSummaries(runId),
      reviews: this.db.list("review", { runId }),
      allowedActions: actions,
      controllingJob: {
        kind: parent ? "research" : "run",
        id: parent?.id ?? run.id,
        status: parent?.status ?? run.status,
        allowedActions: actions,
      },
      progress: {
        completed: results.filter((r) => r.status === "completed").length,
        failed: results.filter((r) => r.status === "failed").length,
        total: results.length,
      },
      events,
      cursor: events.at(-1)?.sequence ?? cursor,
    };
  }
  observe(runId: string, cursor = 0): RunObservation {
    const view = this.view(runId, cursor);
    const { manifest: _manifest, ...run } = view.run;
    return { ...view, run };
  }
  attempt(runId: string, attemptId: string): AttemptDetail {
    this.db.require("run", runId);
    const attempt = this.db.require("attempt", attemptId);
    if (attempt.runId !== runId)
      throw new AppError(
        "not_found",
        "The attempt does not belong to this run.",
      );
    const assessments = this.db.attemptAssessments(runId, attemptId);
    if (!assessments.some((item) => item.scoreSetId === `original_${runId}`)) {
      const assessment = this.db
        .list("assessment", { resultId: attempt.resultId })
        .find((item) => item.attemptId === attempt.id);
      if (assessment)
        assessments.unshift({
          scoreSetId: `original_${runId}`,
          evaluator: this.db.require("run", runId).manifest.evaluator,
          assessment,
        });
    }
    const { adapterCheckpoint: _checkpoint, ...publicAttempt } = attempt;
    return {
      attempt: publicAttempt,
      jevAssessments: this.db
        .jevSummaries(runId)
        .filter((value) => value.attemptId === attemptId),
      events: this.db.events({ runId, attemptId }),
      assessments,
    };
  }
  control(
    runId: string,
    action: Control,
    acknowledgeDuplicateWork = false,
  ): RunView {
    const run = this.db.require("run", runId);
    if (
      action === "resume" &&
      !acknowledgeDuplicateWork &&
      savedTarget(run.manifest).kind === "external" &&
      this.db
        .list("attempt", { runId })
        .some(
          (attempt) =>
            attempt.status === "interrupted" &&
            attempt.remoteCompletion === "unknown",
        )
    )
      throw new AppError(
        "duplicate_work_acknowledgment_required",
        "The external agent may still be running. Acknowledge possible duplicate remote work before resuming.",
      );
    const transition = controlTransition(run.status, action);
    this.db.transaction(() => {
      this.db.update("run", { ...run, ...transition, updatedAt: now() });
      this.db.append({
        runId,
        type: "run.control.requested",
        message: `${action[0]!.toUpperCase()}${action.slice(1)} requested.`,
        data: { action },
      });
    });
    if (action === "halt" || action === "cancel")
      for (const controller of this.controllers.get(runId)?.values() ?? [])
        controller.abort(new Error(action));
    if (action === "resume") this.schedule(runId);
    else if (!this.jobs.has(runId)) this.settleIntent(runId);
    return this.view(runId);
  }
  private schedule(runId: string): void {
    if (this.jobs.has(runId) || this.closing) return;
    const job = this.drive(runId)
      .catch((error: unknown) => {
        const run = this.db.require("run", runId);
        this.db.update("run", {
          ...run,
          status: "failed",
          error: errorMessage(error),
          updatedAt: now(),
        });
        this.db.append({
          runId,
          type: "run.failed",
          message: errorMessage(error),
        });
      })
      .finally(() => {
        this.jobs.delete(runId);
        this.controllers.delete(runId);
      });
    this.jobs.set(runId, job);
  }
  private async drive(runId: string): Promise<void> {
    const run = this.db.require("run", runId);
    if (isTerminal(run.status) || run.intent !== "run")
      return this.settleIntent(runId);
    this.db.update("run", { ...run, status: "running", updatedAt: now() });
    this.db.append({
      runId,
      type: "run.started",
      message: "Evaluation started.",
    });
    this.controllers.set(runId, new Map());
    const worker = async () => {
      while (!this.closing && this.db.require("run", runId).intent === "run") {
        const result = this.db.list("result", {
          runId,
          status: ["pending", "interrupted"],
          limit: 1,
        })[0];
        if (!result) break;
        if (run.researchSessionId) {
          const session = this.db.require("research", run.researchSessionId);
          const reason = checkResearchBudget(this.db, session, 1, runId);
          if (reason) {
            const current = this.db.require("run", runId);
            this.db.update("run", {
              ...current,
              intent: "halt",
              status: "halting",
              error: `Research budget: ${reason}`,
              updatedAt: now(),
            });
            this.db.append({
              runId,
              type: "run.budget.exhausted",
              message: reason,
            });
            break;
          }
        }
        await this.executeResult(run, result);
      }
    };
    const outcomes = await Promise.allSettled(
      Array.from({ length: run.manifest.limits.concurrency }, worker),
    );
    const failure = outcomes.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );
    if (failure) throw failure.reason;
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
    const status =
      run.intent === "cancel"
        ? "cancelled"
        : run.intent === "halt"
          ? "halted"
          : run.intent === "pause"
            ? "paused"
            : unfinished
              ? "halted"
              : "completed";
    this.db.update("run", { ...run, status, updatedAt: now() });
    if (status === "completed" || status === "cancelled")
      this.evaluation.sealOriginal(runId);
    this.db.append({ runId, type: `run.${status}`, message: `Run ${status}.` });
  }
  private async executeResult(
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
    try {
      await mkdir(artifactDirectory, { recursive: true });
      const parent = run.researchSessionId
        ? this.db.require("research", run.researchSessionId)
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
        const current = this.db.require("run", run.id);
        this.db.update("run", {
          ...current,
          status: "halting",
          intent: "halt",
          error:
            "The answer is saved, but target resource cleanup requires recovery before more work.",
          updatedAt: now(),
        });
        this.db.append({
          runId: run.id,
          attemptId: attempt.id,
          type: "target.cleanup.unavailable",
          message:
            "The answer is saved. Target resource cleanup is unresolved; restart the engine to recover.",
        });
      }
      const assessment = await this.evaluation.assess(run, result, sealed);
      if (run.manifest.judge.enabled && !controller.signal.aborted) {
        this.db.append({
          runId: run.id,
          attemptId: attempt.id,
          type: "judge.started",
          message: "Independent judge started.",
        });
        try {
          assessment.judge = judgeVerdictSchema.parse(
            await this.runtime.judge({
              observationLevel: output.evidenceScope,
              configuration: run.manifest.judge,
              question: {
                id: question.id,
                text: question.text,
                tags: question.tags,
                ...(question.context ? { context: question.context } : {}),
                ...(question.answerFormat
                  ? { answerFormat: question.answerFormat }
                  : {}),
              },
              expected: question.expected,
              answer: output.answer,
              artifactDirectory: join(artifactDirectory, "judge"),
              timeoutMs: run.manifest.limits.timeoutMs,
              signal: controller.signal,
            }),
          );
        } catch (error) {
          assessment.judgeError = errorMessage(error);
        }
      } else if (run.manifest.judge.enabled)
        assessment.judgeError = "Judge interrupted before admission.";
      this.db.insert(
        "assessment",
        { ...assessment, runId: run.id, id: id("assessment") },
        true,
      );
      if (run.manifest.jevJudge) {
        const parent = run.researchSessionId
          ? this.db.require("research", run.researchSessionId)
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
      if (
        !interrupted &&
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
        ].includes(code)
      ) {
        const current = this.db.require("run", run.id);
        this.db.update("run", {
          ...current,
          status: "halting",
          intent: "halt",
          error: errorMessage(error),
          updatedAt: now(),
        });
        for (const active of this.controllers.get(run.id)?.values() ?? [])
          active.abort(new Error("A fatal execution failure stopped the run."));
        throw error;
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
        connections: agent.connections.map((binding) => ({
          ...binding,
          credentials: Object.fromEntries(
            (binding.credentialFields ?? []).map((field) => [
              field,
              "${" +
                `${binding.provider.toUpperCase()}_${field.toUpperCase()}` +
                "}",
            ]),
          ),
        })),
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
      if (!isTerminal(run.status)) this.control(runId, "halt");
    }
    await this.waitForIdle();
  }
}
