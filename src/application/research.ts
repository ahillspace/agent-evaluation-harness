import { savedTarget, managedAgent } from "../contracts/targets.js";
import { join } from "node:path";
import {
  type AgentConfig,
  type Control,
  type Json,
  type ResearchEvidenceRequest,
  type ResearchInput,
  type ResearchRecord,
  type ResearchView,
  type RuntimePort,
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
import { RunService } from "./runs.js";
import { checkResearchBudget } from "./research-budget.js";
import { validateResearchProposal } from "../domain/research-proposal.js";

export class ResearchService {
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private closing = false;
  constructor(
    private readonly db: Database,
    private readonly runtime: RuntimePort,
    private readonly runs: RunService,
    private readonly evaluations: EvaluationService,
    private readonly directory: string,
  ) {}
  recover(): void {
    for (const session of this.db
      .list("research")
      .filter((s) => !isTerminal(s.status))) {
      const continuityLost =
        session.phase === "researching" && !session.conversationId;
      this.db.update("research", {
        ...session,
        ...(session.pendingTurn
          ? { interruptedTurns: (session.interruptedTurns ?? 0) + 1 }
          : {}),
        status: continuityLost
          ? "failed"
          : session.intent === "cancel"
            ? "cancelled"
            : session.intent === "pause"
              ? "paused"
              : "halted",
        intent:
          session.intent === "cancel"
            ? "cancel"
            : session.intent === "pause"
              ? "pause"
              : "halt",
        ...(continuityLost
          ? {
              error:
                "The researcher conversation ID was not durably acknowledged before interruption. Start another session explicitly.",
            }
          : {}),
        updatedAt: now(),
      });
    }
  }
  async launch(input: ResearchInput): Promise<ResearchView> {
    if (
      (input.selectionMetric === "llm" && !input.baseline.judge.enabled) ||
      (input.selectionMetric === "jev" && !input.baseline.jevJudge)
    )
      throw new AppError(
        "invalid_input",
        "The research selection metric requires its judge to be enabled for the baseline and every candidate.",
      );
    if (input.baseline.target.kind !== "managed")
      throw new AppError(
        "invalid_input",
        "Research requires a managed target.",
      );
    const key = input.idempotencyKey
      ? `research:${input.idempotencyKey}`
      : undefined;
    const hash = digest(input);
    if (key) {
      const existing = this.db.idempotent(key, hash);
      if (existing) return this.view(existing.id);
    }
    const bank = this.db.require("bankRevision", input.baseline.bankRevisionId);
    const invocationCount =
      (input.baseline.questionIds?.length ?? bank.questions.length) *
      input.baseline.repetitions;
    if (invocationCount > input.maxTargetInvocations)
      throw new AppError(
        "budget_exceeded",
        "The baseline exceeds the target invocation budget.",
      );
    const researcher = await this.runtime.resolveAgent(input.researcher);
    const configuration = { ...input, researcher };
    const sessionId = id("research");
    const initial: ResearchRecord = {
      id: sessionId,
      name: input.name,
      createdAt: now(),
      updatedAt: now(),
      status: "queued",
      intent: "run",
      configuration,
      baselineRunId: "",
      currentRunId: "",
      bestRunId: "",
      runIds: [],
      phase: "baseline",
      turns: [],
    };
    const session = this.db.transaction(() => {
      if (key) {
        const existing = this.db.idempotent(key, hash);
        if (existing) return this.db.require("research", existing.id);
      }
      this.db.insert("research", initial);
      if (key) this.db.remember(key, hash, "research", sessionId);
      return initial;
    });
    if (session.id !== sessionId) return this.view(session.id);
    try {
      const baseline = await this.runs.launch(
        {
          ...input.baseline,
          name: `${input.name}: baseline`,
          idempotencyKey: `research:${sessionId}:baseline`,
        },
        sessionId,
      );
      this.db.update("research", {
        ...session,
        baselineRunId: baseline.run.id,
        currentRunId: baseline.run.id,
        bestRunId: baseline.run.id,
        runIds: [baseline.run.id],
      });
      this.schedule(sessionId);
    } catch (error) {
      this.db.update("research", {
        ...session,
        status: "failed",
        error: errorMessage(error),
        updatedAt: now(),
      });
      throw error;
    }
    return this.view(sessionId);
  }
  view(sessionId: string, cursor = 0): ResearchView {
    const session = this.db.researchSummary(sessionId);
    const events = this.db.events({ sessionId }, cursor, {
      summary: true,
      limit: 200,
    });
    return {
      session,
      allowedActions: allowedActions(session.status),
      events,
      cursor: events.at(-1)?.sequence ?? cursor,
    };
  }
  control(sessionId: string, action: Control): ResearchView {
    const session = this.db.require("research", sessionId);
    const transition = controlTransition(session.status, action);
    this.db.update("research", { ...session, ...transition, updatedAt: now() });
    this.db.append({
      sessionId,
      type: "research.control.requested",
      message: `${action} requested.`,
      data: { action },
    });
    if (action === "halt" || action === "cancel")
      this.controllers.get(sessionId)?.abort(new Error(action));
    if (session.currentRunId) {
      const run = this.db.require("run", session.currentRunId);
      if (allowedActions(run.status).includes(action))
        this.runs.control(run.id, action);
    }
    if (action === "resume") this.schedule(sessionId);
    else if (!this.jobs.has(sessionId)) this.settle(sessionId);
    return this.view(sessionId);
  }
  evidence(sessionId: string, request: ResearchEvidenceRequest): Json {
    const session = this.db.require("research", sessionId);
    if (!session.runIds.includes(request.runId))
      throw new AppError(
        "forbidden",
        "Research evidence is limited to this session.",
      );
    const view = this.runs.view(request.runId);
    const results = request.resultId
      ? view.results.filter((r) => r.id === request.resultId)
      : view.results;
    if (request.resultId && !results.length)
      throw new AppError(
        "not_found",
        "The requested result does not belong to this run.",
      );
    this.db.append({
      sessionId,
      runId: request.runId,
      type: request.includeGold
        ? "research.gold.retrieved"
        : "research.evidence.retrieved",
      message: request.includeGold
        ? "Researcher explicitly retrieved expected answers."
        : "Researcher retrieved saved run evidence.",
      data: {
        resultId: request.resultId ?? null,
        includeGold: request.includeGold ?? false,
      },
    });
    return {
      runId: view.run.id,
      agent: managedAgent(savedTarget(view.run.manifest)) as unknown as Json,
      results: results.map((result) => {
        const question = view.run.manifest.questions.find(
          (q) => q.id === result.questionId,
        )!;
        return {
          resultId: result.id,
          repetition: result.repetition,
          question: question.text,
          context: question.context ?? null,
          status: result.status,
          jevAssessments: view.jevAssessments
            .filter(
              (record) => record.resultId === result.id && record.published,
            )
            .map((record) => ({
              assessmentId: record.id,
              status: record.status,
              checks: (record.checks as unknown as Json) ?? null,
              reviewRequired: record.reviewRequired ?? false,
            })),
          attempts: this.db
            .list("attempt", { runId: request.runId, resultId: result.id })
            .map((a) => ({
              id: a.id,
              status: a.status,
              output: (a.output as unknown as Json) ?? null,
              error: a.error ?? null,
              events: this.db
                .events({ runId: request.runId })
                .filter(
                  (e) =>
                    e.attemptId === a.id &&
                    (request.includeGold ||
                      !(
                        e.type.startsWith("evaluation.") ||
                        e.type.startsWith("judge.")
                      )),
                ) as unknown as Json,
            })),
          ...(request.includeGold ? { expected: question.expected } : {}),
        };
      }),
    };
  }
  private schedule(sessionId: string): void {
    if (this.jobs.has(sessionId) || this.closing) return;
    const job = this.drive(sessionId)
      .catch((error: unknown) => {
        let current = this.db.require("research", sessionId);
        if (current.pendingTurn)
          current = this.db.update("research", {
            ...current,
            interruptedTurns: (current.interruptedTurns ?? 0) + 1,
          });
        const code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "";
        if (
          current.intent !== "run" &&
          (current.conversationId || current.intent === "cancel") &&
          code === "interrupted"
        )
          this.settle(sessionId);
        else
          this.db.update("research", {
            ...current,
            status: "failed",
            error: errorMessage(error),
            updatedAt: now(),
          });
        this.db.append({
          sessionId,
          type: "research.error",
          message: errorMessage(error),
        });
      })
      .finally(() => {
        this.jobs.delete(sessionId);
        this.controllers.delete(sessionId);
      });
    this.jobs.set(sessionId, job);
  }
  private stop(session: ResearchRecord, reason: string): void {
    this.db.update("research", {
      ...session,
      status: "completed",
      phase: "finished",
      stopReason: reason,
      updatedAt: now(),
    });
    this.db.append({
      sessionId: session.id,
      type: "research.completed",
      message: reason,
    });
  }
  private budgetReason(session: ResearchRecord): string | undefined {
    return checkResearchBudget(this.db, session);
  }
  private validateProposal(
    session: ResearchRecord,
    proposal: AgentConfig,
  ): AgentConfig {
    const baseline = managedAgent(
      savedTarget(this.db.require("run", session.baselineRunId).manifest),
    );
    return validateResearchProposal(session.configuration, baseline, proposal);
  }
  private metrics(session: ResearchRecord, runId: string) {
    const baseline = this.db.require("run", session.baselineRunId);
    const settings = baseline.manifest.evaluator.settings;
    const eligibleQuestions = new Set(
      baseline.manifest.questions
        .filter(
          (question) =>
            ({ ...settings, ...settings.questionOverrides[question.id] })
              .referenceDisposition !== "needs_review",
        )
        .map((question) => question.id),
    );
    const eligible = eligibleQuestions.size * baseline.manifest.repetitions;
    const results = this.db
      .list("result", { runId })
      .filter((result) => eligibleQuestions.has(result.questionId));
    const assessments = this.evaluations.original(runId).assessments;
    const metric = session.configuration.selectionMetric ?? "deterministic";
    const jev =
      metric === "jev"
        ? this.db
            .list("jevAssessment", { runId })
            .filter((item) => item.kind === "original")
        : [];
    let correct = 0,
      judged = 0;
    for (const result of results) {
      const assessment = assessments.find(
        (item) => item.resultId === result.id,
      );
      let verdict: boolean | undefined;
      if (metric === "deterministic") {
        const status = assessment?.deterministic.status;
        verdict =
          status === "correct"
            ? true
            : status === "incorrect"
              ? false
              : undefined;
      } else if (metric === "llm")
        verdict = assessment?.judge?.verdict ?? undefined;
      else {
        const saved = jev.find(
          (item) =>
            item.resultId === result.id &&
            item.attemptId === result.completedAttemptId,
        );
        const choice =
          saved?.status === "completed" && !saved.reviewRequired
            ? saved.checks?.answer.choice
            : undefined;
        verdict =
          choice === "acceptable"
            ? true
            : choice === "incorrect"
              ? false
              : undefined;
      }
      if (verdict !== undefined) judged++;
      if (verdict) correct++;
    }
    return {
      runId,
      metric,
      correct,
      judged,
      eligible,
      accuracy: judged ? correct / judged : null,
      eligibleOutcome: eligible ? correct / eligible : null,
      judgedAccuracy: judged ? correct / judged : null,
      coverage: eligible ? judged / eligible : 0,
      completed: results.filter((result) => result.status === "completed")
        .length,
      failed: results.filter((result) => result.status === "failed").length,
    };
  }
  private async drive(sessionId: string): Promise<void> {
    let session = this.db.require("research", sessionId);
    this.db.update("research", {
      ...session,
      status: "running",
      updatedAt: now(),
    });
    while (!this.closing) {
      session = this.db.require("research", sessionId);
      if (session.intent !== "run") return this.settle(sessionId);
      await this.runs.waitFor(session.currentRunId);
      session = this.db.require("research", sessionId);
      if (session.intent !== "run") return this.settle(sessionId);
      const current = this.db.require("run", session.currentRunId);
      if (
        current.status === "halted" &&
        current.error?.startsWith("Research budget:")
      )
        return this.stop(
          session,
          current.error.slice("Research budget:".length).trim(),
        );
      if (current.status !== "completed")
        throw new AppError(
          "evaluation_incomplete",
          `Research requires a completed run; the current run is ${current.status}.`,
        );
      const budget = this.budgetReason(session);
      if (budget) return this.stop(session, budget);
      if (session.pendingProposal) {
        if (session.runIds.length - 1 >= session.configuration.maxCandidates)
          return this.stop(session, "Candidate budget reached.");
        const baseline = this.db.require("run", session.baselineRunId);
        const estimated =
          baseline.manifest.questions.length * baseline.manifest.repetitions;
        const used = this.db.list("attempt", { runId: session.runIds }).length;
        if (used + estimated > session.configuration.maxTargetInvocations)
          return this.stop(
            session,
            "The next candidate exceeds the remaining target invocation budget.",
          );
        const child = await this.runs.launch(
          {
            ...session.configuration.baseline,
            bankRevisionId: baseline.manifest.bank.id,
            evaluatorRevisionId: baseline.manifest.evaluator.id,
            questionIds: baseline.manifest.questions.map((q) => q.id),
            judge: baseline.manifest.judge,
            limits: baseline.manifest.limits,
            repetitions: baseline.manifest.repetitions,
            name: `${session.name}: candidate ${session.runIds.length}`,
            target: { kind: "managed", agent: session.pendingProposal },
            idempotencyKey: `research:${session.id}:candidate:${session.runIds.length}`,
          },
          session.id,
          baseline.manifest.jevJudge,
        );
        this.db.update("research", {
          ...session,
          phase: "evaluating",
          pendingProposal: undefined,
          currentRunId: child.run.id,
          runIds: [...session.runIds, child.run.id],
          updatedAt: now(),
        });
        continue;
      }
      if (
        (session.researcherInvocations ?? session.turns.length) >=
        session.configuration.maxResearcherTurns
      )
        return this.stop(session, "Researcher turn budget reached.");
      const initial = !session.conversationId;
      if (!initial && !session.turns.length)
        this.db.append({
          sessionId,
          type: "research.recovery",
          message:
            "Resuming the acknowledged provider conversation after interruption.",
        });
      const summary = this.metrics(session, current.id);
      const message = initial
        ? JSON.stringify({
            instructions:
              "Optimize the agent configuration. Retrieve run evidence through the provided read interface. Request gold answers only explicitly when necessary. Return disposition keep or discard for the evaluated configuration independently of control continue or stop. Include a complete new proposal when continuing. Accuracy uses completed correctness judgments. Selection uses eligibleOutcome with the fixed eligible baseline denominator; missing executions and unavailable judgments do not shrink it. A candidate cannot replace the best run with worse eligibleOutcome or reduced coverage. Do not change evaluation rules or exceed mutation limits.",
            objective: session.configuration.objective,
            objectiveMetrics: session.configuration.objectiveMetrics,
            objectiveMode: session.configuration.objectiveMode,
            guidance: session.configuration.guidance,
            stopping: {
              allowed: session.configuration.allowResearcherStop,
              guidance: session.configuration.stopGuidance ?? "",
              rule:
                session.configuration.allowResearcherStop === false
                  ? "Do not stop solely because improvement seems unlikely. Propose a distinct candidate until a hard budget is reached. A technical blocker permits control stop with stopCategory blocked and a concrete reason."
                  : "Use control stop to finish, and still give the evaluated candidate a disposition.",
            },
            startingAgent: managedAgent(savedTarget(current.manifest)),
            allowedChanges: session.configuration.allowedChanges,
            searchSpace: session.configuration.searchSpace,
            budgets: {
              maxCandidates: session.configuration.maxCandidates,
              maxDurationMs: session.configuration.maxDurationMs,
              maxTargetInvocations: session.configuration.maxTargetInvocations,
              maxResearcherTurns: session.configuration.maxResearcherTurns,
              maxTotalTokens: session.configuration.maxTotalTokens,
              maxCostUsd: session.configuration.maxCostUsd,
            },
            baselineRun: summary,
          })
        : JSON.stringify({
            completedRun: summary,
            bestRun: this.metrics(session, session.bestRunId),
            remainingCandidates: Math.max(
              0,
              session.configuration.maxCandidates - (session.runIds.length - 1),
            ),
            allowResearcherStop: session.configuration.allowResearcherStop,
            decisionNeeded:
              "Return disposition keep or discard, independently of control continue or stop. To continue, propose a distinct unevaluated configuration. If early stopping is disabled, stop only for a concrete technical blocker or an exhausted hard budget.",
          });
      this.db.update("research", {
        ...session,
        phase: "researching",
        pendingTurn: { input: message, startedAt: now() },
        researcherInvocations:
          (session.researcherInvocations ?? session.turns.length) + 1,
        updatedAt: now(),
      });
      const controller = new AbortController();
      this.controllers.set(sessionId, controller);
      this.db.append({
        sessionId,
        type: "research.turn.started",
        message: initial
          ? "Researcher conversation started after baseline evaluation."
          : "Resuming the same researcher conversation.",
      });
      this.db.append({
        sessionId,
        type: "research.turn.requested",
        message: "Saved researcher input before provider admission.",
        data: {
          input: message,
          conversationId: session.conversationId ?? null,
        },
      });
      const output = await this.runtime.researcher({
        sessionId,
        ...(session.conversationId
          ? { conversationId: session.conversationId }
          : {}),
        configuration: session.configuration.researcher,
        message,
        artifactDirectory: join(
          this.directory,
          "artifacts",
          sessionId,
          `turn-${session.turns.length + 1}`,
        ),
        timeoutMs: Math.min(
          session.configuration.baseline.limits.timeoutMs,
          Math.max(
            100,
            session.configuration.maxDurationMs -
              (Date.now() - Date.parse(session.createdAt)),
          ),
        ),
        signal: controller.signal,
        onEvent: (event) => {
          if (
            event.type === "conversation.created" &&
            event.data &&
            typeof event.data === "object" &&
            !Array.isArray(event.data) &&
            typeof event.data.conversationId === "string"
          ) {
            const latest = this.db.require("research", sessionId);
            if (
              latest.conversationId &&
              latest.conversationId !== event.data.conversationId
            ) {
              controller.abort(new Error("Research conversation changed."));
              throw new AppError(
                "continuity_lost",
                "The provider attempted to replace the research conversation.",
              );
            }
            this.db.update("research", {
              ...latest,
              conversationId: event.data.conversationId,
            });
          }
          this.db.append({ sessionId, ...event });
        },
        readEvidence: async (request) => this.evidence(sessionId, request),
      });
      const latest = this.db.require("research", sessionId);
      if (
        !output.conversationId ||
        (latest.conversationId &&
          latest.conversationId !== output.conversationId)
      )
        throw new AppError(
          "continuity_lost",
          "The provider did not preserve the exact research conversation ID.",
        );
      const proposed = output.proposal
        ? this.validateProposal(latest, output.proposal)
        : undefined;
      const disposition =
        output.disposition ??
        (output.decision === "keep" || output.decision === "discard"
          ? output.decision
          : undefined);
      const control =
        output.control ??
        (output.decision === "stop" || !proposed ? "stop" : "continue");
      const best = this.metrics(latest, latest.bestRunId);
      const keepEligible =
        summary.eligibleOutcome !== null &&
        (best.eligibleOutcome === null ||
          summary.eligibleOutcome >= best.eligibleOutcome) &&
        summary.coverage >= best.coverage;
      const repeated =
        proposed &&
        latest.runIds.some(
          (runId) =>
            digest(proposed) ===
            digest(
              managedAgent(savedTarget(this.db.require("run", runId).manifest)),
            ),
        );
      session = {
        ...latest,
        conversationId: output.conversationId,
        phase: "evaluating",
        pendingTurn: undefined,
        turns: [...latest.turns, { input: message, output, createdAt: now() }],
        ...(disposition === "keep" && keepEligible
          ? { bestRunId: current.id }
          : {}),
        pendingProposal: repeated || control === "stop" ? undefined : proposed,
        updatedAt: now(),
      };
      this.db.update("research", session);
      this.db.append({
        sessionId,
        type: "research.decision",
        message: output.reason ?? output.message,
        data: {
          decision: output.decision ?? null,
          disposition: disposition ?? null,
          control,
          acceptedKeep: disposition === "keep" && keepEligible,
          selection: summary,
          runId: current.id,
          hasProposal: Boolean(proposed),
        },
      });
      if (session.intent !== "run") return this.settle(sessionId);
      if (
        control === "stop" &&
        (session.configuration.allowResearcherStop !== false ||
          (output.stopCategory === "blocked" && Boolean(output.reason?.trim())))
      )
        return this.stop(
          session,
          output.reason ?? "The researcher finished without another candidate.",
        );
      if (session.runIds.length - 1 >= session.configuration.maxCandidates)
        return this.stop(session, "Candidate budget reached.");
      if (!session.pendingProposal) {
        this.db.append({
          sessionId,
          type: "research.continuation.required",
          message: repeated
            ? "The proposed configuration has already been evaluated. Requesting a distinct candidate in the same conversation."
            : "Early stopping is disabled or no candidate was provided. Requesting the next candidate in the same conversation.",
        });
      }
    }
    this.settle(sessionId);
  }
  private settle(sessionId: string): void {
    const session = this.db.require("research", sessionId);
    if (isTerminal(session.status)) return;
    const status =
      session.intent === "cancel"
        ? "cancelled"
        : session.intent === "pause"
          ? "paused"
          : "halted";
    this.db.update("research", { ...session, status, updatedAt: now() });
    this.db.append({
      sessionId,
      type: `research.${status}`,
      message: `Research ${status}.`,
    });
  }
  async waitForIdle(): Promise<void> {
    while (this.jobs.size) await Promise.all([...this.jobs.values()]);
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const sessionId of this.jobs.keys()) {
      const session = this.db.require("research", sessionId);
      if (!isTerminal(session.status)) this.control(sessionId, "halt");
    }
    await this.waitForIdle();
  }
}
