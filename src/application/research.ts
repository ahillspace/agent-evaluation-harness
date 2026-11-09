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
  faultTransition,
  cancellationRequested,
} from "../domain/lifecycle.js";
import { Database } from "../storage/database.js";
import { AssessmentPassService } from "./assessment-passes.js";
import { RunService, type ResearchControlAdmission } from "./runs.js";
import { checkResearchBudget } from "./research-budget.js";
import { validateResearchProposal } from "../domain/research-proposal.js";
import { AnswerSources } from "./answer-sources.js";

/** The complete serialized research evidence response is limited to 16 MiB. */
export const MAX_RESEARCH_EVIDENCE_BYTES = 16 * 1024 * 1024;

export function researchJevChoice(
  record:
    | {
        status: "completed" | "pending" | "error";
        reviewRequired?: boolean;
        checks?: { answer: { choice: string } };
      }
    | undefined,
): "acceptable" | "incorrect" | undefined {
  if (record?.status !== "completed" || record.reviewRequired) return undefined;
  const choice = record.checks?.answer.choice;
  return choice === "acceptable" || choice === "incorrect" ? choice : undefined;
}

export class ResearchService {
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly launches = new Map<
    string,
    { hash: string; receipt: Promise<ResearchView> }
  >();
  private readonly controllers = new Map<string, AbortController>();
  private closing = false;
  constructor(
    private readonly db: Database,
    private readonly runtime: RuntimePort,
    private readonly runs: RunService,
    private readonly passes: AssessmentPassService,
    private readonly directory: string,
  ) {}
  recover(): void {
    for (let session of this.db
      .list("research")
      .filter((s) => !isTerminal(s.status))) {
      if (cancellationRequested(session)) {
        this.db.update("research", {
          ...session,
          ...faultTransition(session, true),
          ...(session.pendingTurn
            ? { interruptedTurns: (session.interruptedTurns ?? 0) + 1 }
            : {}),
          updatedAt: now(),
        });
        continue;
      }
      if (!session.baselineRunId) {
        const baselineInput = {
          ...session.configuration.baseline,
          name: `${session.name}: baseline`,
          idempotencyKey: `research:${session.id}:baseline`,
        };
        const receipt = this.db.idempotent(
          `run:${baselineInput.idempotencyKey}`,
          digest(baselineInput),
        );
        const baseline = receipt
          ? this.db.require("run", receipt.id)
          : undefined;
        if (!baseline || baseline.researchSessionId !== session.id) {
          if (session.intent === "pause") {
            this.db.update("research", {
              ...session,
              status: "paused",
              updatedAt: now(),
            });
            continue;
          }
          this.db.update("research", {
            ...session,
            status: "failed",
            intent: "halt",
            error:
              "Research initialization was interrupted before its baseline was saved. Start a new research session explicitly.",
            updatedAt: now(),
          });
          continue;
        }
        session = {
          ...session,
          baselineRunId: baseline.id,
          currentRunId: baseline.id,
          bestRunId: baseline.id,
          runIds: [baseline.id],
        };
      }
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
    if (this.closing)
      throw new AppError("unavailable", "The engine is shutting down.");
    const key = input.idempotencyKey;
    if (!key) return this.initialize(input);
    const hash = digest(input);
    const pending = this.launches.get(key);
    if (pending) {
      if (pending.hash !== hash)
        throw new AppError(
          "idempotency_conflict",
          "This idempotency key was already used with different input.",
        );
      return pending.receipt;
    }
    const receipt = this.initialize(input);
    this.launches.set(key, { hash, receipt });
    try {
      return await receipt;
    } finally {
      this.launches.delete(key);
    }
  }
  private async initialize(input: ResearchInput): Promise<ResearchView> {
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
      if (existing) return this.launchReceipt(existing.id);
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
      this.db.insert("research", initial);
      if (key) this.db.remember(key, hash, "research", sessionId);
      return initial;
    });
    const sourceSequence = this.db.controlSequence({ sessionId });
    try {
      await this.launchBaseline(session);
      this.schedule(sessionId);
    } catch (error) {
      const current = this.db.require("research", sessionId);
      if (current.intent !== "run") this.settle(sessionId);
      else if (
        digest(current) === digest(session) &&
        this.db.controlSequence({ sessionId }) === sourceSequence
      )
        this.db.update("research", {
          ...current,
          ...faultTransition(current, true),
          error: errorMessage(error),
          updatedAt: now(),
        });
      throw error;
    }
    return this.launchReceipt(sessionId);
  }
  private researchAdmission(
    expected: ResearchRecord,
    sourceSequence: number,
  ): ResearchRecord {
    const current = this.db.require("research", expected.id);
    if (this.closing || current.intent !== "run" || isTerminal(current.status))
      throw new AppError(
        "interrupted",
        "Research stopped before target admission.",
      );
    if (
      digest(current) !== digest(expected) ||
      this.db.controlSequence({ sessionId: expected.id }) !== sourceSequence
    )
      throw new AppError(
        "conflict",
        "Research changed while preparing target admission.",
      );
    return current;
  }
  private async launchBaseline(session: ResearchRecord): Promise<void> {
    const sourceSequence = this.db.controlSequence({ sessionId: session.id });
    await this.runs.launch(
      {
        ...session.configuration.baseline,
        name: `${session.name}: baseline`,
        idempotencyKey: `research:${session.id}:baseline`,
      },
      session.id,
      undefined,
      (baseline) => {
        const current = this.researchAdmission(session, sourceSequence);
        if (baseline.researchSessionId !== current.id)
          throw new AppError(
            "conflict",
            "The baseline receipt belongs to a different owner.",
          );
        this.db.update("research", {
          ...current,
          baselineRunId: baseline.id,
          currentRunId: baseline.id,
          bestRunId: baseline.id,
          runIds: [baseline.id],
        });
      },
    );
  }
  private launchReceipt(sessionId: string): ResearchView {
    const receipt = this.view(sessionId);
    if (!receipt.session.baselineRunId || !receipt.session.currentRunId)
      throw new AppError(
        "launch_incomplete",
        receipt.session.error ??
          "Research initialization did not save a baseline. Start a new research session explicitly.",
        { sessionId },
      );
    return receipt;
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
  prepareControl(sessionId: string, action: Control): ResearchControlAdmission {
    const session = this.db.require("research", sessionId);
    const transition = controlTransition(session.status, action);
    const acknowledgeRunning =
      action === "resume" &&
      session.intent === "run" &&
      ["queued", "running"].includes(session.status);
    const expected = digest(session);
    const sourceSequence = this.db.controlSequence({ sessionId });
    const run = session.currentRunId
      ? this.db.require("run", session.currentRunId)
      : undefined;
    const runSequence = run
      ? this.db.controlSequence({ runId: run.id })
      : undefined;
    const commit = () => {
      const current = this.db.require("research", sessionId);
      if (
        digest(current) !== expected ||
        this.db.controlSequence({ sessionId }) !== sourceSequence
      )
        throw new AppError(
          "conflict",
          "The research session changed while preparing its control action.",
        );
      if (
        run &&
        (digest(this.db.require("run", run.id)) !== digest(run) ||
          this.db.controlSequence({ runId: run.id }) !== runSequence)
      )
        throw new AppError(
          "conflict",
          "The current Research child changed while preparing its control action.",
        );
      if (acknowledgeRunning) return;
      this.db.update("research", {
        ...current,
        ...transition,
        updatedAt: now(),
      });
      this.db.append({
        sessionId,
        type: "research.control.requested",
        message: `${action} requested.`,
        data: { action },
      });
    };
    const researchOwned =
      !isTerminal(session.status) &&
      run?.researchSessionId === sessionId &&
      (run.execution?.controller === "research" || !run.execution);
    return {
      targetRunId:
        researchOwned && allowedActions(run.status).includes(action)
          ? run.id
          : undefined,
      commit,
      activate: () => {
        if (acknowledgeRunning) return;
        if (action === "halt" || action === "cancel")
          this.controllers.get(sessionId)?.abort(new Error(action));
        if (action === "resume") this.schedule(sessionId);
        else if (!this.jobs.has(sessionId)) this.settle(sessionId);
      },
    };
  }
  async control(sessionId: string, action: Control): Promise<ResearchView> {
    const session = this.db.require("research", sessionId);
    if (session.currentRunId) {
      await this.runs.control(
        {
          runId: session.currentRunId,
          action,
          acknowledgeDuplicateWork: false,
        },
        () => this.prepareControl(sessionId, action),
      );
    } else {
      const admission = this.prepareControl(sessionId, action);
      this.db.transaction(admission.commit);
      admission.activate();
    }
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
    const response = {
      runId: view.run.id,
      agent: managedAgent(savedTarget(view.run.manifest)) as unknown as Json,
      results: [] as Json[],
    };
    let bytes = 0;
    const charge = (value: unknown, comma = false) => {
      bytes += Buffer.byteLength(JSON.stringify(value)) + Number(comma);
      if (bytes > MAX_RESEARCH_EVIDENCE_BYTES)
        throw new AppError(
          "evidence_limit",
          `Research evidence exceeds the 16 MiB serialized response limit. ${request.resultId ? "This result cannot be returned in full." : "Select a resultId to request one result at a time."} No partial evidence was returned.`,
        );
    };
    charge(response);
    const answers = new AnswerSources(this.db);
    const applications = answers.applications(request.runId);
    for (const result of results) {
      const question = view.run.manifest.questions.find(
        (q) => q.id === result.questionId,
      )!;
      const resultEvidence = {
        resultId: result.id,
        repetition: result.repetition,
        question: question.text,
        context: question.context ?? null,
        status: result.answerSource ? "completed" : result.status,
        ...(result.answerSource
          ? { answerSource: result.answerSource as unknown as Json }
          : {}),
        jevAssessments: view.jevAssessments
          .filter((record) => record.resultId === result.id && record.published)
          .map((record) => ({
            assessmentId: record.id,
            status: record.status,
            checks: (record.checks as unknown as Json) ?? null,
            reviewRequired: record.reviewRequired ?? false,
          })),
        attempts: [] as Json[],
        ...(request.includeGold ? { expected: question.expected } : {}),
      };
      charge(resultEvidence, response.results.length > 0);
      response.results.push(resultEvidence);
      const attemptIds = new Set([
        ...result.attemptIds,
        ...applications.flatMap((application) =>
          application.bindings
            .filter((binding) => binding.resultId === result.id)
            .map((binding) => binding.source.attemptId),
        ),
      ]);
      for (const attemptId of attemptIds) {
        const { attempt } = answers.authorize(request.runId, attemptId);
        const attemptEvidence = {
          id: attempt.id,
          runId: attempt.runId,
          resultId: attempt.resultId,
          status: attempt.status,
          output: (attempt.output as unknown as Json) ?? null,
          error: attempt.error ?? null,
          events: [] as Json[],
        };
        charge(attemptEvidence, resultEvidence.attempts.length > 0);
        resultEvidence.attempts.push(attemptEvidence);
        let cursor = 0;
        for (;;) {
          const page = this.db.events(
            { runId: attempt.runId, attemptId },
            cursor,
            { limit: 500 },
          );
          if (!page.length) break;
          for (const event of page) {
            if (
              !request.includeGold &&
              (event.type.startsWith("evaluation.") ||
                event.type.startsWith("judge."))
            )
              continue;
            charge(event, attemptEvidence.events.length > 0);
            attemptEvidence.events.push(event as unknown as Json);
          }
          cursor = page.at(-1)!.sequence;
        }
      }
    }
    return response;
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
        const continuityLost =
          current.phase === "researching" &&
          !!current.pendingTurn &&
          !current.conversationId;
        if (
          current.intent !== "run" &&
          (cancellationRequested(current) || !continuityLost)
        )
          this.settle(sessionId);
        else
          this.db.update("research", {
            ...current,
            ...faultTransition(current, true),
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
    session = this.db.require("research", session.id);
    if (isTerminal(session.status)) return;
    if (session.intent !== "run") return this.settle(session.id);
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
    const metric = session.configuration.selectionMetric ?? "deterministic";
    const pass = this.passes.original(runId, metric);
    const originallyAnswered = new Set(
      pass.judgments
        .filter((judgment) => judgment.attemptId)
        .map((judgment) => judgment.resultId),
    );
    const originalAttempts = new Map(
      results.map((result) => [
        result.id,
        result.attemptIds
          .map((attemptId) => this.db.require("attempt", attemptId))
          .filter((attempt) => (attempt.executionId ?? runId) === runId)
          .at(-1),
      ]),
    );
    let correct = 0,
      judged = 0;
    for (const result of results) {
      const assessment = pass.judgments.find(
        (item) => item.resultId === result.id,
      );
      let verdict: boolean | undefined;
      if (metric === "deterministic") {
        const status = assessment?.status;
        verdict =
          status === "correct"
            ? true
            : status === "incorrect"
              ? false
              : undefined;
      } else if (metric === "llm")
        verdict =
          assessment?.status === "correct"
            ? true
            : assessment?.status === "incorrect"
              ? false
              : undefined;
      else {
        const saved = assessment
          ? this.passes.boundJev(pass, assessment)
          : undefined;
        const choice = researchJevChoice(saved);
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
      completed: results.filter((result) => originallyAnswered.has(result.id))
        .length,
      failed: results.filter(
        (result) =>
          !originallyAnswered.has(result.id) &&
          originalAttempts.get(result.id)?.status === "failed",
      ).length,
    };
  }
  private async drive(sessionId: string): Promise<void> {
    let session = this.db.require("research", sessionId);
    if (isTerminal(session.status) || session.intent !== "run")
      return this.settle(sessionId);
    this.db.update("research", {
      ...session,
      status: "running",
      updatedAt: now(),
    });
    while (!this.closing) {
      session = this.db.require("research", sessionId);
      if (session.intent !== "run") return this.settle(sessionId);
      if (!session.baselineRunId) {
        await this.launchBaseline(session);
        continue;
      }
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
        const sourceSequence = this.db.controlSequence({ sessionId });
        await this.runs.launch(
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
          (child) => {
            const current = this.researchAdmission(session, sourceSequence);
            if (child.researchSessionId !== current.id)
              throw new AppError(
                "conflict",
                "The candidate receipt belongs to a different owner.",
              );
            this.db.update("research", {
              ...current,
              phase: "evaluating",
              pendingProposal: undefined,
              currentRunId: child.id,
              runIds: [...current.runIds, child.id],
              updatedAt: now(),
            });
          },
        );
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
      if (!isTerminal(session.status) && session.intent !== "cancel")
        await this.control(sessionId, "halt");
    }
    await this.waitForIdle();
  }
}
