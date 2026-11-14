import { join } from "node:path";
import {
  jsonSchema,
  judgeSchema,
  jevJudgeSelectionSchema,
  type AssessmentPass,
  type AssessmentPassSummary,
  type AssessmentPassObservation,
  type AssessmentPassDetail,
  type AnswerSource,
  type ResultRecord,
  type CommandInput,
  type PassJudgment,
  type RuntimePort,
  type RunRecord,
  type RunView,
  type RunObservation,
  type JevAssessmentRecord,
  type Verdict,
} from "../contracts.js";
import {
  Database,
  type AutomaticAssessmentInput,
  type PassSummaryBasis,
} from "../storage/database.js";
import { AppError, errorMessage } from "../domain/errors.js";
import { digest, id, now } from "../domain/identity.js";
import { EvaluationService, type PreviewRunSnapshot } from "./evaluations.js";
import { LlmJudgeService } from "./llm-judge.js";
import { JevService } from "./jev.js";
import { AnswerSources } from "./answer-sources.js";
import { restoreLegacyReviews } from "./legacy-reviews.js";

function passRates(coverage: AssessmentPass["coverage"]) {
  const accuracy = coverage.judged ? coverage.correct / coverage.judged : null;
  return {
    accuracy,
    judgedAccuracy: accuracy,
    eligibleOutcome: coverage.eligible
      ? coverage.correct / coverage.eligible
      : null,
  };
}
function originalPassesFirst<T extends Pick<AssessmentPass, "id" | "source">>(
  passes: T[],
  runId: string,
): T[] {
  const rank = (pass: T) =>
    pass.id === `original_${pass.source}_${runId}`
      ? ["deterministic", "llm", "jev"].indexOf(pass.source)
      : 3;
  return passes.sort((left, right) => rank(left) - rank(right));
}
function jevAssessmentState(
  source: AssessmentPass["source"],
  judgment: PassJudgment,
): PassJudgment["jevAssessmentStatus"] {
  if (judgment.jevAssessmentStatus) return judgment.jevAssessmentStatus;
  if (source !== "jev" || judgment.review) return undefined;
  if (judgment.status === "correct" || judgment.status === "incorrect")
    return "completed";
  return judgment.status === "error" ? "error" : undefined;
}
function observeJudgment(
  source: AssessmentPass["source"],
  {
    request: _request,
    response: _response,
    details: _details,
    ...judgment
  }: PassJudgment,
): AssessmentPassObservation["judgments"][number] {
  const jevAssessmentStatus =
    judgment.jevAssessmentId && jevAssessmentState(source, judgment);
  return jevAssessmentStatus ? { ...judgment, jevAssessmentStatus } : judgment;
}
export function observePass(pass: AssessmentPass): AssessmentPassObservation {
  const { configuration: _configuration, ...metadata } = pass;
  const observation = {
    ...metadata,
    ...passRates(pass.coverage),
    judgments: pass.judgments.map((judgment) =>
      observeJudgment(pass.source, judgment),
    ),
  };
  return { ...observation, observationRevision: digest(observation) };
}
export function summarizePass(pass: AssessmentPass): AssessmentPassSummary {
  const {
    configuration: _configuration,
    judgments: _judgments,
    basis,
    ...summary
  } = pass;
  const {
    eligibleResultIds: _eligible,
    excludedResultIds: _excluded,
    ...referenceBasis
  } = basis;
  return { ...summary, ...passRates(pass.coverage), basis: referenceBasis };
}
type JudgmentMeasurement = Pick<
  PassJudgment,
  | "resultId"
  | "attemptId"
  | "status"
  | "response"
  | "jevAssessmentId"
  | "review"
>;
function computedJudgmentStatus(
  source: "deterministic" | "llm",
  assessment: {
    deterministic: string;
    judgeVerdict?: boolean | null;
    judgeError?: unknown;
  },
): PassJudgment["status"] {
  if (source === "llm")
    return assessment.judgeError
      ? "error"
      : assessment.judgeVerdict === true
        ? "correct"
        : assessment.judgeVerdict === false
          ? "incorrect"
          : "unjudged";
  return assessment.deterministic === "unavailable"
    ? "unjudged"
    : assessment.deterministic === "unscorable"
      ? "excluded"
      : (assessment.deterministic as PassJudgment["status"]);
}
function jevJudgmentStatus(
  status: string,
  answer: { choice: string; confidence: number } | undefined,
  threshold: number,
): PassJudgment["status"] {
  if (status === "error") return "error";
  if (status !== "completed" || !answer || answer.confidence < threshold)
    return "unjudged";
  return answer.choice === "acceptable"
    ? "correct"
    : answer.choice === "incorrect"
      ? "incorrect"
      : "unjudged";
}
export function measurePass(pass: AssessmentPass): AssessmentPass {
  return { ...pass, ...measureJudgments(pass) };
}
function measureJudgments(
  pass: Pick<AssessmentPass, "source" | "status" | "basis"> & {
    judgments: JudgmentMeasurement[];
  },
) {
  const eligible = new Set(pass.basis.eligibleResultIds);
  const judgments = pass.judgments.filter((j) => eligible.has(j.resultId));
  const correct = judgments.filter((j) => j.status === "correct").length;
  const incorrect = judgments.filter((j) => j.status === "incorrect").length;
  const judged = correct + incorrect;
  const retryableJudgments =
    pass.source === "human" || pass.status === "running"
      ? 0
      : pass.judgments.filter(
          (j) =>
            j.attemptId &&
            (j.status === "error" ||
              (j.status === "unjudged" &&
                j.response === undefined &&
                !j.jevAssessmentId)),
        ).length;
  const retryUnavailableReason = retryableJudgments
    ? undefined
    : pass.status === "running"
      ? "Wait for this assessment to finish."
      : pass.source === "human"
        ? "Retry the computed parent assessment before deriving another human review."
        : "No failed judgments to retry. Failed executions require an execution retry; completed abstentions remain recorded.";
  return {
    retryableJudgments,
    retryUnavailableReason,
    coverage: {
      eligible: eligible.size,
      answered: judgments.filter((j) => j.attemptId).length,
      judged,
      correct,
      incorrect,
      unjudged: judgments.filter((j) => j.status === "unjudged").length,
      errors: judgments.filter((j) => j.status === "error").length,
      excluded: pass.basis.excludedResultIds.length,
      reviewed: pass.judgments.filter((j) => j.review).length,
      overridden: pass.judgments.filter(
        (j) => j.review && j.review.previousStatus !== j.status,
      ).length,
    },
    eligibleOutcome: eligible.size ? correct / eligible.size : null,
    accuracy: judged ? correct / judged : null,
    judgedAccuracy: judged ? correct / judged : null,
  };
}
export class AssessmentPassService {
  constructor(
    private readonly db: Database,
    private readonly evaluations: EvaluationService,
    private readonly jev: JevService,
    private readonly runtime: RuntimePort,
    private readonly directory: string,
  ) {}
  recover(): void {
    for (const pass of this.db.list("assessmentPass", { status: "running" }))
      this.db.update(
        "assessmentPass",
        measurePass({
          ...pass,
          status: "interrupted",
          finishedAt: now(),
          judgments: pass.judgments.map((j) =>
            j.status === "unjudged" &&
            j.attemptId &&
            j.response === undefined &&
            !j.jevAssessmentId
              ? {
                  ...j,
                  status: "error",
                  explanation:
                    "Assessment interrupted. Retry this saved pass to assess unfinished answers.",
                }
              : j,
          ),
        }),
      );
    for (const run of this.db.list("run"))
      if (
        ["completed", "cancelled", "failed"].includes(run.status) ||
        run.execution?.settledAt
      )
        this.db.transaction(() => {
          this.sealOriginal(run.id);
          this.sealCurrent(run.id);
        });
    restoreLegacyReviews(this.db, this);
  }
  private skeleton({
    run,
    results,
    source,
    name,
    configuration,
    answerBindings,
    passId = id("pass"),
  }: {
    run: RunRecord;
    results: readonly Pick<ResultRecord, "id" | "questionId">[];
    source: AssessmentPass["source"];
    name: string;
    configuration: AssessmentPass["configuration"];
    answerBindings: ReadonlyMap<string, Readonly<AnswerSource>>;
    passId?: string;
  }): AssessmentPass {
    const evaluator = configuration.evaluator ?? run.manifest.evaluator;
    const questions =
      configuration.referenceBank?.questions ?? run.manifest.questions;
    const excluded = results
      .filter((result) => {
        const settings = {
          ...evaluator.settings,
          ...evaluator.settings.questionOverrides[result.questionId],
        };
        return settings.referenceDisposition === "needs_review";
      })
      .map((r) => r.id);
    return measurePass({
      id: passId,
      runId: run.id,
      name,
      source,
      status: "running",
      createdAt: now(),
      configuration: {
        ...configuration,
        referenceBank: configuration.referenceBank ?? run.manifest.bank,
      },
      basis: {
        bankRevisionId: configuration.referenceBank?.id ?? run.manifest.bank.id,
        evaluatorRevisionId: evaluator.id,
        eligibleResultIds: results
          .filter((r) => !excluded.includes(r.id))
          .map((r) => r.id),
        excludedResultIds: excluded,
        referenceHash: digest(
          run.manifest.questions
            .map((original) => questions.find((q) => q.id === original.id)!)
            .map((q) => ({ id: q.id, expected: q.expected }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        ),
      },
      judgments: results.map((r) => {
        const answer = answerBindings.get(r.id);
        return {
          resultId: r.id,
          ...(answer
            ? {
                attemptId: answer.attemptId,
                ...(answer.runId !== run.id
                  ? {
                      source: {
                        runId: answer.runId,
                        resultId: answer.resultId,
                      },
                    }
                  : {}),
                evidenceHash: answer.evidenceHash,
              }
            : {}),
          status: excluded.includes(r.id) ? "excluded" : "unjudged",
          explanation: excluded.includes(r.id)
            ? "Excluded by the selected reference policy."
            : answer
              ? "Assessment pending."
              : "Not assessed in this score.",
        };
      }),
      coverage: {
        eligible: 0,
        answered: 0,
        judged: 0,
        correct: 0,
        incorrect: 0,
        unjudged: 0,
        errors: 0,
        excluded: 0,
        reviewed: 0,
        overridden: 0,
      },
      accuracy: null,
      judgedAccuracy: null,
    });
  }
  /** Polling reads compact metadata; sealed evidence and configuration load only for details. */
  summaries(runId: string): AssessmentPassSummary[] {
    const saved = this.db.assessmentPassSummaries(runId);
    return originalPassesFirst(
      [
        ...this.automaticPasses(
          runId,
          new Set(saved.map((pass) => pass.id)),
          false,
        ).map(summarizePass),
        ...this.compactLegacyPasses(runId).map(summarizePass),
        ...saved.map((pass) => ({ ...pass, ...passRates(pass.coverage) })),
      ],
      runId,
    );
  }
  list(runId: string, details: true): AssessmentPass[];
  list(runId: string, details?: false): AssessmentPassObservation[];
  list(
    runId: string,
    details = false,
  ): Array<AssessmentPass | AssessmentPassObservation> {
    const saved = details
      ? this.db.list("assessmentPass", { runId })
      : this.db.assessmentPassObservations(runId);
    const missing = this.automaticPasses(
      runId,
      new Set(saved.map((pass) => pass.id)),
      details,
    );
    const legacy = details
      ? this.db
          .list("scoreSet", { runId })
          .filter(
            (scores) =>
              scores.kind !== "original" &&
              !saved.some((pass) => pass.id === `scores_${scores.id}`),
          )
          .map((scores) => this.legacyScorePass(runId, scores.id))
      : this.compactLegacyPasses(runId);
    return originalPassesFirst([...missing, ...legacy, ...saved], runId)
      .map((pass) => ({ ...pass, ...passRates(pass.coverage) }))
      .map((pass) => (details ? pass : observePass(pass)));
  }
  currentAutomaticId(
    runId: string,
    source: "deterministic" | "llm" | "jev" = "deterministic",
  ): string {
    const run = this.db.require("run", runId);
    return !run.execution || run.execution.id === run.id
      ? `original_${source}_${run.id}`
      : `automatic_${source}_${run.execution.id}`;
  }
  private automaticPasses(
    runId: string,
    saved: ReadonlySet<string>,
    details: boolean,
  ): AssessmentPass[] {
    const state = this.db.runAssessmentState(runId);
    const sources = [
      "deterministic" as const,
      ...(state.judgeEnabled ? ["llm" as const] : []),
      ...(state.jevEnabled ? ["jev" as const] : []),
    ];
    const families = [
      true,
      ...(state.execution && state.execution.id !== runId ? [false] : []),
    ]
      .map((first) => ({
        first,
        missing: sources.filter(
          (source) =>
            !saved.has(
              first
                ? `original_${source}_${runId}`
                : `automatic_${source}_${state.execution!.id}`,
            ),
        ),
      }))
      .filter((family) => family.missing.length);
    if (!families.length) return [];
    const basis = this.db.runAssessmentBasis(runId).basis;
    const run = details ? this.db.require("run", runId) : undefined;
    return families.flatMap(({ first, missing }) => {
      const inputs = this.db.automaticAssessmentInputs(runId, first);
      for (const input of inputs) {
        this.verifyAutomaticBinding(runId, input);
        if (details && input.source)
          new AnswerSources(this.db).verify(input.result, input.source);
      }
      return missing.map((source) =>
        this.automaticPass(runId, state, basis, inputs, source, first, run),
      );
    });
  }
  private verifyAutomaticBinding(
    runId: string,
    input: AutomaticAssessmentInput,
  ): void {
    if (!input.attemptId) return;
    if (!input.attempt)
      throw new AppError(
        "not_found",
        `attempt ${input.attemptId} was not found.`,
      );
    const { source, attempt, owner, sourceRun, result } = input;
    if (
      !source ||
      !owner ||
      !sourceRun ||
      attempt.runId !== source.runId ||
      attempt.resultId !== source.resultId ||
      owner.runId !== source.runId ||
      owner.questionId !== result.questionId ||
      owner.repetition !== result.repetition ||
      (source.runId !== runId &&
        (sourceRun.retryOf?.runId !== runId ||
          !sourceRun.retryOf.resultIds.includes(result.id) ||
          !sourceRun.sameManifest))
    )
      throw new AppError(
        "incompatible_basis",
        "The saved answer does not belong to this question, repetition, and frozen configuration.",
      );
    if (
      attempt.status !== "completed" ||
      !attempt.hasOutput ||
      !attempt.finishedAt ||
      !attempt.evidenceHash ||
      source.evidenceHash !== attempt.evidenceHash
    )
      throw new AppError(
        "evidence_integrity",
        "The saved answer does not match its completed, sealed evidence.",
      );
  }
  private automaticPass(
    runId: string,
    state: ReturnType<Database["runAssessmentState"]>,
    reference: PassSummaryBasis,
    inputs: AutomaticAssessmentInput[],
    source: "deterministic" | "llm" | "jev",
    first: boolean,
    run?: RunRecord,
  ): AssessmentPass {
    const excluded = inputs
      .filter(
        ({ result }) =>
          (reference.dispositions[result.questionId] ??
            reference.defaultDisposition) === "needs_review",
      )
      .map(({ result }) => result.id);
    const judgments: PassJudgment[] = inputs.map((input) => {
      const answer = input.source;
      const judgment: PassJudgment = {
        resultId: input.result.id,
        ...(answer
          ? {
              attemptId: answer.attemptId,
              evidenceHash: answer.evidenceHash,
              ...(answer.runId !== runId
                ? { source: { runId: answer.runId, resultId: answer.resultId } }
                : {}),
            }
          : {}),
        status: excluded.includes(input.result.id) ? "excluded" : "unjudged",
        explanation: excluded.includes(input.result.id)
          ? "Excluded by the selected reference policy."
          : answer
            ? "Assessment pending."
            : "Not assessed in this score.",
      };
      if (!answer || judgment.status === "excluded") return judgment;
      if (source === "jev")
        return input.jev ? this.jevJudgment(judgment, input.jev) : judgment;
      if (!input.raw) return judgment;
      let assessment = input.raw.assessment;
      if (run) {
        if (input.raw.recordId)
          assessment = this.db.require("assessment", input.raw.recordId);
        else if (input.raw.scoreSetId)
          assessment = this.db
            .require("scoreSet", input.raw.scoreSetId)
            .assessments.find(
              (item) =>
                item.resultId === input.raw!.assessment.resultId &&
                item.attemptId === answer.attemptId,
            )!;
      }
      if (source === "deterministic")
        return {
          ...judgment,
          status: computedJudgmentStatus("deterministic", {
            deterministic: assessment.deterministic.status,
          }),
          explanation: assessment.deterministic.explanation,
          ...(assessment.deterministic.details
            ? { details: assessment.deterministic.details }
            : {}),
        };
      return {
        ...judgment,
        ...(assessment.judgeAdmitted ||
        assessment.judge ||
        assessment.judgeError ||
        assessment.judgeUsage
          ? { judgmentId: `original_llm_${answer.attemptId}` }
          : {}),
        status: computedJudgmentStatus("llm", {
          deterministic: assessment.deterministic.status,
          judgeError: assessment.judgeError,
          judgeVerdict: assessment.judge?.verdict,
        }),
        explanation:
          assessment.judgeError ??
          assessment.judge?.explanation ??
          "The judge did not return a verdict.",
        ...(assessment.judgeRequest !== undefined
          ? { request: assessment.judgeRequest }
          : {}),
        ...(run
          ? assessment.judgeResponse !== undefined ||
            assessment.judge !== undefined
            ? {
                response:
                  assessment.judgeResponse !== undefined
                    ? assessment.judgeResponse
                    : jsonSchema.parse(assessment.judge),
              }
            : {}
          : input.raw.judgeResponded
            ? { response: true }
            : {}),
        ...((assessment.judgeUsage ?? assessment.judge?.usage)
          ? { usage: assessment.judgeUsage ?? assessment.judge?.usage }
          : {}),
      };
    });
    const terminal =
      ["completed", "failed", "cancelled"].includes(state.status) ||
      !!state.execution?.settledAt ||
      (first && !!state.execution && state.execution.id !== runId);
    const status = terminal
      ? "completed"
      : ["paused", "halted", "interrupted"].includes(state.status)
        ? "interrupted"
        : "running";
    return measurePass({
      id: first
        ? `original_${source}_${runId}`
        : `automatic_${source}_${state.execution!.id}`,
      runId,
      name: `${first ? "Original" : "Updated"} ${source === "deterministic" ? "deterministic" : source === "llm" ? "LLM judge" : "Jev"}`,
      source,
      status,
      createdAt: first ? state.createdAt : state.execution!.createdAt,
      ...(terminal
        ? { finishedAt: state.execution?.settledAt ?? state.updatedAt }
        : {}),
      configuration: run
        ? {
            evaluator: run.manifest.evaluator,
            referenceBank: run.manifest.bank,
            ...(source === "llm" ? { judge: run.manifest.judge } : {}),
            ...(source === "jev" ? { jevJudge: run.manifest.jevJudge } : {}),
          }
        : {},
      basis: {
        bankRevisionId: reference.bankRevisionId,
        evaluatorRevisionId: reference.evaluatorRevisionId,
        referenceHash: reference.referenceHash,
        eligibleResultIds: inputs
          .filter((input) => !excluded.includes(input.result.id))
          .map((input) => input.result.id),
        excludedResultIds: excluded,
      },
      judgments,
      coverage: {
        eligible: 0,
        answered: 0,
        judged: 0,
        correct: 0,
        incorrect: 0,
        unjudged: 0,
        errors: 0,
        excluded: 0,
        reviewed: 0,
        overridden: 0,
      },
      accuracy: null,
      judgedAccuracy: null,
    });
  }
  private compactLegacyPasses(runId: string): AssessmentPass[] {
    return this.db
      .legacyAssessmentInputs(runId)
      .map(({ id, name, createdAt, basis, inputs }) => {
        const state = {
          ...this.db.runAssessmentState(runId),
          status: "completed" as const,
        };
        const pass = this.automaticPass(
          runId,
          state,
          basis,
          inputs,
          "deterministic",
          true,
        );
        return { ...pass, id, name, createdAt, finishedAt: createdAt };
      });
  }
  sealCurrent(runId: string): void {
    const run = this.db.require("run", runId);
    if (
      !run.execution?.settledAt &&
      !["completed", "cancelled", "failed"].includes(run.status)
    )
      return;
    this.freezeCurrent(runId);
  }
  /** Preserve the current raw score before replacing its execution context. */
  freezeCurrent(runId: string): void {
    const run = this.db.require("run", runId);
    const sources = [
      "deterministic" as const,
      ...(run.manifest.judge.enabled ? ["llm" as const] : []),
      ...(run.manifest.jevJudge ? ["jev" as const] : []),
    ];
    for (const source of sources) {
      const passId = this.currentAutomaticId(runId, source);
      if (this.db.get("assessmentPass", passId)) continue;
      const { pass } = this.readBase(runId, passId);
      this.db.insert("assessmentPass", pass);
    }
  }
  sealOriginal(runId: string): void {
    const run = this.db.require("run", runId);
    if (
      !run.execution?.settledAt &&
      !(run.execution && run.execution.id !== run.id) &&
      !["completed", "cancelled", "failed"].includes(run.status)
    )
      return;
    for (const pass of this.list(runId, true))
      if (
        pass.id.startsWith("original_") &&
        !this.db.get("assessmentPass", pass.id)
      )
        this.db.insert("assessmentPass", pass);
  }
  original(
    runId: string,
    source: "deterministic" | "llm" | "jev" = "deterministic",
  ): AssessmentPass {
    return this.get(runId, `original_${source}_${runId}`);
  }
  originalDeterministicVerdicts(runId: string): ReadonlyMap<string, Verdict> {
    return this.deterministicVerdicts(runId, this.original(runId));
  }
  currentDeterministicVerdicts(runId: string): ReadonlyMap<string, Verdict> {
    return this.deterministicVerdicts(
      runId,
      this.get(runId, this.currentAutomaticId(runId)),
    );
  }
  previewSnapshot(runId: string): PreviewRunSnapshot {
    const run = this.db.require("run", runId);
    const passId =
      !run.execution || run.execution.id === run.id
        ? `original_deterministic_${run.id}`
        : `automatic_deterministic_${run.execution.id}`;
    const pass = this.get(runId, passId);
    const verdicts = this.deterministicVerdicts(runId, pass);
    const judgments = new Map(
      pass.judgments.map((judgment) => [judgment.resultId, judgment]),
    );
    return {
      run,
      passId: pass.id,
      answers: this.db.list("result", { runId }).map((result) => {
        const judgment = judgments.get(result.id);
        if (!judgment)
          throw new AppError(
            "incompatible_basis",
            "The current score does not cover this Run's results.",
          );
        if (judgment.attemptId && !judgment.evidenceHash)
          throw new AppError(
            "evidence_integrity",
            "The current score has no sealed evidence hash for its answer.",
          );
        const before = verdicts.get(result.id);
        return {
          result,
          ...(judgment.attemptId
            ? {
                source: {
                  runId: judgment.source?.runId ?? runId,
                  resultId: judgment.source?.resultId ?? result.id,
                  attemptId: judgment.attemptId,
                  evidenceHash: judgment.evidenceHash!,
                },
              }
            : {}),
          ...(before ? { before } : {}),
        };
      }),
    };
  }
  private deterministicVerdicts(
    runId: string,
    pass: AssessmentPass,
  ): ReadonlyMap<string, Verdict> {
    const owners = [
      ...new Set(
        pass.judgments.map((judgment) => judgment.source?.runId ?? runId),
      ),
    ];
    const legacy = this.db
      .list("scoreSet", { runId })
      .find((scores) => scores.kind === "original");
    const original =
      legacy?.assessments.map((assessment) => ({ ...assessment, runId })) ?? [];
    const physical = this.db.list("assessment", { runId: owners });
    const assessments = [
      ...(pass.id === `original_deterministic_${runId}`
        ? [...original, ...physical]
        : [...physical, ...original]),
      ...owners
        .filter((owner) => owner !== runId)
        .flatMap((owner) =>
          this.db
            .list("scoreSet", { runId: owner })
            .filter((scores) => scores.kind === "original")
            .flatMap((scores) =>
              scores.assessments.map((assessment) => ({
                ...assessment,
                runId: owner,
              })),
            ),
        ),
    ];
    return new Map(
      pass.judgments.flatMap((judgment) => {
        if (!judgment.attemptId) return [];
        const assessment = assessments.find(
          (item) =>
            (item.runId ?? runId) === (judgment.source?.runId ?? runId) &&
            item.attemptId === judgment.attemptId &&
            item.resultId === (judgment.source?.resultId ?? judgment.resultId),
        );
        if (!assessment) return [];
        const verdict = assessment.deterministic;
        // Exclusion cards omit the raw verdict's reference note and diagnostic details.
        // Every verdict must match the captured status rather than later recovered grading.
        if (
          computedJudgmentStatus("deterministic", {
            deterministic: verdict.status,
          }) !== judgment.status
        )
          return [];
        if (
          judgment.status !== "excluded" &&
          verdict.explanation !== judgment.explanation
        )
          return [];
        return [[judgment.resultId, verdict] as const];
      }),
    );
  }
  latestDeterministic(
    runId: string,
    evaluatorRevisionId: string,
  ): AssessmentPass | undefined {
    return this.list(runId, true)
      .filter(
        (pass) =>
          pass.source === "deterministic" &&
          pass.status === "completed" &&
          pass.configuration.evaluator?.id === evaluatorRevisionId &&
          (!pass.id.startsWith("scores_") ||
            this.db.get("scoreSet", pass.id.slice("scores_".length))
              ?.published !== false),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .at(-1);
  }
  snapshotLegacyScore(runId: string, scoreSetId: string): AssessmentPass {
    if (scoreSetId === `original_${runId}`)
      return this.snapshot(runId, `original_deterministic_${runId}`);
    const pass = this.legacyScorePass(runId, scoreSetId);
    if (!this.db.get("assessmentPass", pass.id))
      this.db.insert("assessmentPass", pass);
    return pass;
  }
  private legacyScorePass(runId: string, scoreSetId: string): AssessmentPass {
    const run = this.db.require("run", runId);
    const scores = this.db.require("scoreSet", scoreSetId);
    if (scores.runId !== runId)
      throw new AppError(
        "incompatible_basis",
        "The score set belongs to a different run.",
      );
    const terminal = ["completed", "failed", "cancelled"].includes(run.status);
    const passId =
      scores.kind === "original" && terminal
        ? `original_deterministic_${runId}`
        : `scores_${scores.id}`;
    const saved = this.db.get("assessmentPass", passId);
    if (saved) return saved;
    let pass = this.skeleton({
      run,
      results: this.db.list("result", { runId }),
      source: "deterministic",
      name: `${scores.evaluator.name} (revision ${scores.evaluator.number})${scores.published ? "" : " (unpublished historical score)"}`,
      configuration: {
        evaluator: scores.evaluator,
        referenceBank: scores.referenceBank,
      },
      answerBindings: new Map(
        scores.assessments.map((assessment) => [
          assessment.resultId,
          this.db.answerSource(assessment.attemptId),
        ]),
      ),
      passId,
    });
    pass = {
      ...pass,
      createdAt: scores.createdAt,
      finishedAt: scores.createdAt,
      status: "completed",
      judgments: pass.judgments.map((j) => {
        const assessment = scores.assessments.find(
          (a) => a.resultId === j.resultId,
        );
        if (!assessment || j.status === "excluded") return j;
        const status = assessment.deterministic.status;
        return {
          ...j,
          attemptId: assessment.attemptId,
          evidenceHash: this.db.require("attempt", assessment.attemptId)
            .evidenceHash,
          ...(this.db.require("attempt", assessment.attemptId).runId !== runId
            ? {
                source: {
                  runId: this.db.require("attempt", assessment.attemptId).runId,
                  resultId: this.db.require("attempt", assessment.attemptId)
                    .resultId,
                },
              }
            : {}),
          status: computedJudgmentStatus("deterministic", {
            deterministic: status,
          }),
          explanation: assessment.deterministic.explanation,
          ...(assessment.deterministic.details
            ? { details: assessment.deterministic.details }
            : {}),
        };
      }),
    };
    pass = measurePass(pass);
    return pass;
  }
  private jevJudgment(
    j: PassJudgment,
    record: NonNullable<AutomaticAssessmentInput["jev"]>,
  ): PassJudgment {
    return {
      ...j,
      jevAssessmentId: record.id,
      jevAssessmentStatus: record.status,
      status: jevJudgmentStatus(
        record.status,
        record.checks?.answer,
        record.criteria.confidenceThreshold,
      ),
      explanation:
        record.error?.message ??
        (record.checks
          ? `Answer: ${record.checks.answer.choice}; evidence: ${record.checks.evidence?.choice ?? "not assessed"}; reference: ${record.checks.reference?.choice ?? "not assessed"}.`
          : "No classification returned."),
      ...(record.usage ? { usage: record.usage } : {}),
    };
  }
  private readBase(
    runId: string,
    passId: string,
    expectedObservationRevision?: string,
  ) {
    const saved = this.db.get("assessmentPass", passId);
    const pass =
      saved?.runId === runId
        ? saved
        : !saved
          ? this.list(runId, true).find((p) => p.id === passId)
          : undefined;
    if (!pass)
      throw new AppError(
        "not_found",
        "This assessment pass does not belong to the run.",
      );
    const observationRevision = observePass(pass).observationRevision;
    if (
      expectedObservationRevision !== undefined &&
      expectedObservationRevision !== observationRevision
    )
      throw new AppError(
        "conflict",
        "This saved score changed. Refresh its judgments before continuing.",
      );
    return { pass, observationRevision };
  }
  get(
    runId: string,
    passId: string,
    expectedObservationRevision?: string,
  ): AssessmentPass {
    return this.detail(
      this.readBase(runId, passId, expectedObservationRevision).pass,
    );
  }
  read(
    runId: string,
    passId: string,
    expectedObservationRevision?: string,
  ): AssessmentPassDetail {
    const stored = this.db.assessmentInspection(passId);
    if (stored && stored.pass.runId !== runId)
      throw new AppError(
        "not_found",
        "This assessment pass does not belong to the run.",
      );
    const pass = stored?.pass;
    const observed = pass
      ? observePass(pass)
      : this.list(runId).find((item) => item.id === passId);
    if (!observed)
      throw new AppError(
        "not_found",
        "This assessment pass does not belong to the run.",
      );
    const observationRevision = observed.observationRevision;
    if (
      expectedObservationRevision !== undefined &&
      expectedObservationRevision !== observationRevision
    )
      throw new AppError(
        "conflict",
        "This saved score changed. Refresh its judgments before continuing.",
      );
    if (!pass) return this.fallbackInspection(runId, observed);
    const exchanges = new Set(stored.recordedExchangeResultIds);
    return {
      configuration: pass.configuration,
      observationRevision,
      judgments: pass.judgments.map((original) => {
        const judgment = observeJudgment(pass.source, original);
        return {
          ...judgment,
          ...(original.details !== undefined
            ? { details: original.details }
            : {}),
          ...(!judgment.jevAssessmentId && exchanges.has(judgment.resultId)
            ? { hasRecordedExchange: true }
            : {}),
        };
      }),
    };
  }
  private fallbackInspection(
    runId: string,
    observed: AssessmentPassObservation,
  ): AssessmentPassDetail {
    const legacyId = observed.id.startsWith("scores_")
      ? observed.id.slice("scores_".length)
      : undefined;
    const run = this.db.require("run", runId);
    const inputs = this.db.automaticAssessmentInputs(
      runId,
      observed.id.startsWith("original_") || !!legacyId,
      legacyId,
    );
    const configuration: AssessmentPass["configuration"] = legacyId
      ? this.db.legacyInspectionConfiguration(runId, legacyId)
      : {
          evaluator: run.manifest.evaluator,
          referenceBank: run.manifest.bank,
          ...(observed.source === "llm" ? { judge: run.manifest.judge } : {}),
          ...(observed.source === "jev"
            ? { jevJudge: run.manifest.jevJudge }
            : {}),
        };
    return {
      configuration,
      observationRevision: observed.observationRevision,
      judgments: observed.judgments.map((judgment) => {
        const input = inputs.find(
          (item) =>
            item.result.id === judgment.resultId &&
            item.attemptId === judgment.attemptId,
        );
        if (
          !input?.raw ||
          !judgment.attemptId ||
          judgment.status === "excluded"
        )
          return judgment;
        const inspection = this.db.automaticJudgmentInspection(
          input.raw,
          input.raw.assessment.resultId,
          judgment.attemptId,
        );
        return {
          ...judgment,
          ...(observed.source === "deterministic" &&
          inspection.details !== undefined
            ? { details: inspection.details }
            : {}),
          ...(observed.source === "llm" &&
          !judgment.jevAssessmentId &&
          inspection.hasRecordedExchange
            ? { hasRecordedExchange: true }
            : {}),
        };
      }),
    };
  }
  private detail(pass: AssessmentPass): AssessmentPass {
    const captured =
      pass.status !== "running" && !!this.db.get("assessmentPass", pass.id);
    return {
      ...pass,
      ...passRates(pass.coverage),
      judgments: pass.judgments.map((original) => {
        const state = jevAssessmentState(pass.source, original);
        const j =
          original.jevAssessmentId && state
            ? { ...original, jevAssessmentStatus: state }
            : original;
        if (!j.jevAssessmentId) return j;
        if (captured && j.jevAssessmentStatus === "pending") return j;
        const record = this.boundJev(pass, j);
        return record
          ? {
              ...j,
              ...(record.request ? { request: record.request } : {}),
              ...(record.response ? { response: record.response } : {}),
              ...(record.error
                ? {
                    error: {
                      ...record.error,
                      ...(record.httpStatus
                        ? { httpStatus: record.httpStatus }
                        : {}),
                    },
                  }
                : {}),
              evidenceHash: record.attemptEvidenceHash,
            }
          : j;
      }),
    };
  }
  /** Resolve only the physical judge record and state captured by this pass. */
  boundJev(
    pass: AssessmentPass,
    judgment: PassJudgment,
  ): JevAssessmentRecord | undefined {
    const state = jevAssessmentState(pass.source, judgment);
    if (!judgment.jevAssessmentId || !state) return undefined;
    const record = this.db.get("jevAssessment", judgment.jevAssessmentId);
    if (
      !record ||
      record.status !== state ||
      record.attemptId !== judgment.attemptId ||
      (judgment.evidenceHash !== undefined &&
        record.attemptEvidenceHash !== judgment.evidenceHash)
    )
      return undefined;
    const answers = new AnswerSources(this.db);
    try {
      // Assessments own logical results; copied judgments retain physical owners.
      const { attempt, result } = answers.authorize(
        record.runId,
        record.attemptId,
      );
      const logical = answers.authorize(pass.runId, record.attemptId).result;
      if (
        result.id !== record.resultId ||
        logical.id !== judgment.resultId ||
        record.attemptEvidenceHash !== attempt.evidenceHash ||
        (judgment.source &&
          (judgment.source.runId !== attempt.runId ||
            judgment.source.resultId !== attempt.resultId))
      )
        return undefined;
    } catch (error) {
      if (
        error instanceof AppError &&
        ["not_found", "incompatible_basis", "evidence_integrity"].includes(
          error.code,
        )
      )
        return undefined;
      throw error;
    }
    return record;
  }
  readJev(
    runId: string,
    passId: string,
    assessmentId: string,
    expectedObservationRevision: string,
  ): JevAssessmentRecord {
    const { pass } = this.readBase(runId, passId, expectedObservationRevision);
    const judgment = pass.judgments.find(
      (item) => item.jevAssessmentId === assessmentId,
    );
    if (!judgment)
      throw new AppError(
        "incompatible_basis",
        "This Jev assessment does not belong to the selected score's answer.",
      );
    const record = this.boundJev(pass, judgment);
    if (!record)
      throw new AppError(
        "conflict",
        "This Jev record no longer matches the state captured by this score. Use a current score to inspect the settled assessment.",
      );
    return record;
  }
  snapshot(runId: string, passId: string): AssessmentPass {
    const pass = this.get(runId, passId);
    if (this.db.get("assessmentPass", pass.id)) return pass;
    const legacy = pass.id.startsWith("scores_")
      ? this.db.get("scoreSet", pass.id.slice("scores_".length))
      : undefined;
    if (legacy?.runId === runId)
      return this.snapshotLegacyScore(runId, legacy.id);
    return this.db.insert(
      "assessmentPass",
      measurePass({
        ...pass,
        id: id("pass"),
        name: `${pass.name} snapshot`,
        status: pass.status === "running" ? "interrupted" : pass.status,
        finishedAt: now(),
      }),
    );
  }
  select(runId: string, passId: string): { selectedAssessmentPassId: string } {
    const saved = this.db.get("assessmentPass", passId);
    if (
      !(saved?.runId === runId) &&
      !this.list(runId).some((pass) => pass.id === passId)
    )
      throw new AppError(
        "not_found",
        "This assessment does not belong to the run.",
      );
    this.db.update("run", {
      ...this.db.require("run", runId),
      selectedAssessmentPassId: passId,
    });
    return { selectedAssessmentPassId: passId };
  }
  enrich<T extends RunView | RunObservation>(view: T): T {
    const assessmentPasses = this.list(view.run.id);
    const selectedAssessmentPassId =
      view.run.selectedAssessmentPassId ?? assessmentPasses[0]?.id;
    return { ...view, assessmentPasses, selectedAssessmentPassId };
  }
  async create(
    input: CommandInput<"runs.assess">,
    signal: AbortSignal,
  ): Promise<AssessmentPass> {
    const run = this.db.require("run", input.runId);
    const bank = this.db.require("bank", run.manifest.bank.bankId);
    const evaluator = this.db.require(
      "evaluator",
      input.evaluatorRevisionId ?? bank.activeEvaluatorRevisionId,
    );
    if (evaluator.bankId !== bank.id)
      throw new AppError(
        "incompatible_basis",
        "The evaluator belongs to another bank.",
      );
    const referenceBank = input.bankRevisionId
      ? this.db.require("bankRevision", input.bankRevisionId)
      : undefined;
    if (referenceBank) {
      if (referenceBank.bankId !== bank.id)
        throw new AppError(
          "incompatible_basis",
          "The reference belongs to another bank.",
        );
      for (const q of run.manifest.questions) {
        const ref = referenceBank.questions.find((r) => r.id === q.id);
        if (!ref || ref.text !== q.text || ref.context !== q.context)
          throw new AppError(
            "incompatible_basis",
            "Corrected references must describe the same frozen questions.",
          );
      }
    }
    const configuration: AssessmentPass["configuration"] = {
      evaluator,
      ...(referenceBank ? { referenceBank } : {}),
    };
    if (input.source === "llm") {
      const judge = judgeSchema.parse(input.judge ?? run.manifest.judge);
      if (!judge.agent)
        throw new AppError(
          "invalid_input",
          "Select an LLM judge configuration.",
        );
      configuration.judge = {
        ...judge,
        enabled: true,
        agent: await this.runtime.resolveAgent(judge.agent),
      };
    }
    if (input.source === "jev") {
      configuration.jevJudge = input.jevJudge
        ? await this.jev.resolve(
            bank.id,
            jevJudgeSelectionSchema.parse(input.jevJudge),
          )
        : run.manifest.jevJudge;
      if (!configuration.jevJudge)
        throw new AppError(
          "invalid_input",
          "Select a Jev profile and connection.",
        );
    }
    const results = new AnswerSources(this.db).results(run.id);
    const answerBindings = new Map(
      results.flatMap((result) =>
        result.answerSource ? [[result.id, result.answerSource] as const] : [],
      ),
    );
    const pass = this.db.insert(
      "assessmentPass",
      this.skeleton({
        run,
        results,
        source: input.source,
        name: input.name,
        configuration,
        answerBindings,
      }),
    );
    return this.evaluate(pass, signal);
  }
  async retry(
    input: CommandInput<"runs.retry-assessment">,
    signal: AbortSignal,
  ): Promise<AssessmentPass> {
    const parent = this.get(
      input.runId,
      input.passId,
      input.expectedObservationRevision,
    );
    if (parent.status === "running")
      throw new AppError(
        "invalid_state",
        "Wait for the current assessment to finish.",
      );
    if (parent.source === "human")
      throw new AppError(
        "invalid_input",
        "Retry the computed parent assessment before deriving a human review.",
      );
    if (
      !parent.judgments.some(
        (j) =>
          j.attemptId &&
          (j.status === "error" ||
            (j.status === "unjudged" &&
              j.response === undefined &&
              !j.jevAssessmentId)),
      )
    )
      throw new AppError(
        "invalid_state",
        "This pass has no failed judgments to retry.",
      );
    const pass = this.db.transaction(() => {
      const frozen = this.snapshot(input.runId, parent.id);
      return this.db.insert("assessmentPass", {
        ...frozen,
        id: id("pass"),
        name: input.name ?? `${parent.name} retry`,
        parentPassId: frozen.id,
        status: "running",
        createdAt: now(),
        finishedAt: undefined,
      });
    });
    return this.evaluate(pass, signal);
  }
  private async evaluate(
    initial: AssessmentPass,
    signal: AbortSignal,
  ): Promise<AssessmentPass> {
    let pass = initial;
    const run = this.db.require("run", pass.runId);
    for (let index = 0; index < pass.judgments.length; index++) {
      let judgment = pass.judgments[index]!;
      if (
        !judgment.attemptId ||
        !(
          judgment.status === "error" ||
          (judgment.status === "unjudged" &&
            judgment.response === undefined &&
            !judgment.jevAssessmentId)
        )
      )
        continue;
      if (signal.aborted) break;
      const attemptId = judgment.attemptId;
      judgment = {
        resultId: judgment.resultId,
        attemptId,
        ...(judgment.source ? { source: judgment.source } : {}),
        ...(judgment.evidenceHash
          ? { evidenceHash: judgment.evidenceHash }
          : {}),
        status: "unjudged",
        explanation: "Assessment pending.",
      };
      pass = measurePass({
        ...pass,
        judgments: pass.judgments.map((item, i) =>
          i === index ? judgment : item,
        ),
      });
      this.db.update("assessmentPass", pass);
      let next: PassJudgment;
      const judgmentId = id("judgment");
      try {
        const attempt = this.db.require("attempt", attemptId);
        if (
          attempt.status !== "completed" ||
          !attempt.output ||
          digest(attempt.output) !== attempt.evidenceHash
        )
          throw new AppError(
            "evidence_integrity",
            "The saved answer does not match its sealed evidence.",
          );
        const result = this.db.require("result", judgment.resultId);
        if (pass.source === "deterministic") {
          const assessed = await this.evaluations.assess(
            run,
            result,
            attempt,
            pass.configuration.evaluator,
            pass.configuration.referenceBank,
          );
          const status = assessed.deterministic.status;
          next = {
            ...judgment,
            status:
              status === "unavailable"
                ? "unjudged"
                : status === "unscorable"
                  ? "excluded"
                  : status,
            explanation: assessed.deterministic.explanation,
            ...(assessed.deterministic.details
              ? { details: assessed.deterministic.details }
              : {}),
          };
        } else if (pass.source === "jev") {
          const record = await this.jev.evaluate(
            run.id,
            attempt.id,
            pass.configuration.jevJudge!,
            "rejudge",
            true,
            signal,
            undefined,
            undefined,
            {
              evaluator: pass.configuration.evaluator!,
              referenceBank: pass.configuration.referenceBank,
            },
          );
          next = this.jevJudgment(judgment, record);
          if (record.checks?.reference?.choice === "suspected_issue") {
            const findingId = `finding_${digest({ runId: run.id, questionId: result.questionId, kind: "reference" }).slice(0, 24)}`;
            if (!this.db.get("bankFinding", findingId))
              this.db.insert("bankFinding", {
                id: findingId,
                bankId: run.manifest.bank.bankId,
                bankRevisionId: pass.basis.bankRevisionId,
                questionId: result.questionId,
                kind: "reference",
                status: "open",
                title: "Jev flagged a possible reference issue",
                note: next.explanation,
                createdAt: now(),
                runId: run.id,
                resultId: result.id,
                passId: pass.id,
              });
          }
        } else {
          const assessed = await new LlmJudgeService(
            this.db,
            this.runtime,
          ).evaluate({
            runId: run.id,
            attemptId: attempt.id,
            configuration: pass.configuration.judge!,
            artifactDirectory: join(
              this.directory,
              "runs",
              run.id,
              "assessments",
              pass.id,
              attempt.id,
            ),
            signal,
            pass: { id: pass.id, index, judgmentId },
            basis: {
              evaluator: pass.configuration.evaluator ?? run.manifest.evaluator,
              referenceBank: pass.configuration.referenceBank,
            },
          });
          const verdict = assessed.judge;
          next = {
            ...judgment,
            ...(assessed.judgeAdmitted ? { judgmentId } : {}),
            ...(assessed.judgeRequest !== undefined
              ? { request: assessed.judgeRequest }
              : {}),
            ...(assessed.judgeResponse !== undefined
              ? { response: assessed.judgeResponse }
              : {}),
            status: assessed.judgeError
              ? "error"
              : verdict?.verdict === true
                ? "correct"
                : verdict?.verdict === false
                  ? "incorrect"
                  : "unjudged",
            explanation:
              assessed.judgeError ??
              verdict?.explanation ??
              "The judge returned no explanation.",
            ...(assessed.judgeUsage ? { usage: assessed.judgeUsage } : {}),
          };
        }
      } catch (error) {
        next = {
          ...pass.judgments[index]!,
          status: "error",
          explanation: errorMessage(error),
        };
      }
      pass = measurePass({
        ...pass,
        judgments: pass.judgments.map((j, i) => (i === index ? next : j)),
      });
      this.db.update("assessmentPass", pass);
    }
    pass = measurePass({
      ...pass,
      status: signal.aborted ? "interrupted" : "completed",
      finishedAt: now(),
    });
    this.db.update("assessmentPass", pass);
    this.db.append({
      runId: run.id,
      type: "assessment.completed",
      message: `Saved assessment: ${pass.name}.`,
      data: { passId: pass.id, source: pass.source },
    });
    this.select(run.id, pass.id);
    return pass;
  }
  review(
    input: CommandInput<"runs.review-assessment">,
    creation = { id: id("pass"), createdAt: now(), select: true },
  ): AssessmentPass {
    let parent = this.get(
      input.runId,
      input.parentPassId,
      input.expectedObservationRevision,
    );
    if (parent.status === "running")
      throw new AppError(
        "invalid_state",
        "Wait for this assessment to finish before saving a human review.",
      );
    if (
      new Set(input.overrides.map((o) => o.resultId)).size !==
      input.overrides.length
    )
      throw new AppError("invalid_input", "Review each result at most once.");
    const judgments = structuredClone(parent.judgments);
    for (const override of input.overrides) {
      const judgment = judgments.find((j) => j.resultId === override.resultId);
      if (!judgment)
        throw new AppError(
          "invalid_input",
          "The reviewed result does not belong to this assessment.",
        );
      if (override.exclude && !override.note?.trim())
        throw new AppError(
          "invalid_input",
          "Explain why this result is excluded.",
        );
      if (override.verdict !== null && !judgment.attemptId)
        throw new AppError(
          "evidence_unavailable",
          "A failed execution has no sealed answer to judge. Add a note or exclude the result instead.",
        );
      const previousStatus = judgment.status;
      if (override.exclude) judgment.status = "excluded";
      else if (override.verdict !== null)
        judgment.status = override.verdict ? "correct" : "incorrect";
      judgment.review = {
        reviewer: input.reviewer ?? "Local reviewer",
        note: override.note ?? "",
        previousStatus,
        createdAt: creation.createdAt,
      };
      if (override.note) judgment.explanation = override.note;
    }
    parent = this.snapshot(input.runId, parent.id);
    const excludedResultIds = judgments
      .filter((j) => j.status === "excluded")
      .map((j) => j.resultId);
    const pass = measurePass({
      ...parent,
      id: creation.id,
      name: input.name,
      source: "human",
      parentPassId: parent.id,
      status: "completed",
      createdAt: creation.createdAt,
      finishedAt: creation.createdAt,
      judgments,
      basis: {
        ...parent.basis,
        eligibleResultIds: judgments
          .filter((j) => j.status !== "excluded")
          .map((j) => j.resultId),
        excludedResultIds,
      },
    });
    this.db.insert("assessmentPass", pass);
    if (creation.select) this.select(input.runId, pass.id);
    return pass;
  }
}
