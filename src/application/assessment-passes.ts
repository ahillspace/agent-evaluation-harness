import { join } from "node:path";
import {
  jsonSchema,
  judgeSchema,
  jevJudgeSelectionSchema,
  type AssessmentPass,
  type AssessmentPassSummary,
  type CommandInput,
  type PassJudgment,
  type RuntimePort,
  type RunRecord,
  type RunView,
  type RunObservation,
  type JevAssessmentRecord,
} from "../contracts.js";
import { Database } from "../storage/database.js";
import { AppError, errorMessage } from "../domain/errors.js";
import { digest, id, now } from "../domain/identity.js";
import { EvaluationService } from "./evaluations.js";
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
              (j.status === "unjudged" && !j.response && !j.jevAssessmentId)),
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
            !j.response &&
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
    restoreLegacyReviews(this.db, this);
  }
  private skeleton(
    run: RunRecord,
    source: AssessmentPass["source"],
    name: string,
    configuration: AssessmentPass["configuration"],
    passId = id("pass"),
    useAppliedAnswers = true,
  ): AssessmentPass {
    const evaluator = configuration.evaluator ?? run.manifest.evaluator;
    const questions =
      configuration.referenceBank?.questions ?? run.manifest.questions;
    const results = useAppliedAnswers
      ? new AnswerSources(this.db).results(run.id)
      : this.db.list("result", { runId: run.id });
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
        const source = useAppliedAnswers ? r.answerSource : undefined;
        const attemptId = source?.attemptId ?? r.completedAttemptId;
        return {
          resultId: r.id,
          ...(attemptId
            ? {
                attemptId,
                ...(source && source.runId !== run.id
                  ? {
                      source: {
                        runId: source.runId,
                        resultId: source.resultId,
                      },
                    }
                  : {}),
                evidenceHash:
                  source?.evidenceHash ??
                  this.db.answerSource(attemptId).evidenceHash,
              }
            : {}),
          status: excluded.includes(r.id) ? "excluded" : "unjudged",
          explanation: excluded.includes(r.id)
            ? "Excluded by the selected reference policy."
            : attemptId
              ? "Assessment pending."
              : `Execution ${r.status}; no sealed answer.`,
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
  /** List cards use compact metadata; full immutable passes remain a deliberate detail read. */
  summaries(runId: string): AssessmentPassSummary[] {
    const saved = this.db.assessmentPassSummaries(runId);
    const run = this.db.runAssessmentState(runId);
    const sources: AssessmentPass["source"][] = [
      "deterministic",
      ...(run.judgeEnabled ? ["llm" as const] : []),
      ...(run.jevEnabled ? ["jev" as const] : []),
    ];
    const missing = sources.filter(
      (source) =>
        !saved.some((pass) => pass.id === `original_${source}_${runId}`),
    );
    const legacy = this.db.legacyScoreSummaryInputs(runId);
    if (!missing.length && !legacy.length)
      return saved.map((pass) => ({ ...pass, ...passRates(pass.coverage) }));
    const originalBasis = missing.length
      ? this.db.runAssessmentBasis(runId).basis
      : undefined;
    const results = this.db.resultAssessmentMetadata(runId);
    const original = new Map(
      this.db
        .originalAssessmentMetadata(runId)
        .map((assessment) => [assessment.resultId, assessment]),
    );
    const jev = new Map<
      string,
      ReturnType<Database["originalJevMetadata"]>[number]
    >();
    if (missing.includes("jev"))
      for (const record of this.db.originalJevMetadata(runId)) {
        const key = JSON.stringify([record.resultId, record.attemptId]);
        if (!jev.has(key)) jev.set(key, record);
      }
    const make = (
      source: AssessmentPass["source"],
      seed?: ReturnType<Database["legacyScoreSummaryInputs"]>[number],
    ): AssessmentPassSummary => {
      const basis = seed?.basis ?? originalBasis!;
      const assessments = seed
        ? new Map(
            seed.assessments.map((assessment) => [
              assessment.resultId,
              assessment,
            ]),
          )
        : original;
      const excluded = new Set(
        results
          .filter(
            (result) =>
              (basis.dispositions[result.questionId] ??
                basis.defaultDisposition) === "needs_review",
          )
          .map((result) => result.id),
      );
      const judgments: JudgmentMeasurement[] = results.map((result) => {
        const judgment: JudgmentMeasurement = {
          resultId: result.id,
          ...(result.completedAttemptId
            ? { attemptId: result.completedAttemptId }
            : {}),
          status: excluded.has(result.id) ? "excluded" : "unjudged",
        };
        if (excluded.has(result.id) || (!seed && !result.completedAttemptId))
          return judgment;
        if (source === "jev") {
          const record = jev.get(
            JSON.stringify([result.id, result.completedAttemptId]),
          );
          if (!record) return judgment;
          judgment.jevAssessmentId = record.id;
          judgment.status = jevJudgmentStatus(
            record.status,
            record.choice !== null && record.confidence !== null
              ? { choice: record.choice, confidence: record.confidence }
              : undefined,
            record.threshold,
          );
          return judgment;
        }
        const assessment = assessments.get(result.id);
        if (!assessment) return judgment;
        if (seed) judgment.attemptId = assessment.attemptId;
        judgment.status = computedJudgmentStatus(
          source === "llm" ? "llm" : "deterministic",
          assessment,
        );
        if (source === "llm" && assessment.judgeResponded)
          judgment.response = true;
        return judgment;
      });
      const terminal =
        !!seed || ["completed", "failed", "cancelled"].includes(run.status);
      const status = terminal
        ? "completed"
        : ["paused", "halted", "interrupted"].includes(run.status)
          ? "interrupted"
          : "running";
      const referenceBasis = {
        bankRevisionId: basis.bankRevisionId,
        evaluatorRevisionId: basis.evaluatorRevisionId,
        referenceHash: basis.referenceHash,
      };
      return {
        id: seed?.id ?? `original_${source}_${runId}`,
        runId,
        source,
        name:
          seed?.name ??
          (source === "deterministic"
            ? "Original deterministic"
            : source === "llm"
              ? "Original LLM judge"
              : "Original Jev"),
        createdAt: seed?.createdAt ?? run.createdAt,
        ...(terminal ? { finishedAt: seed?.createdAt ?? run.updatedAt } : {}),
        status,
        basis: referenceBasis,
        ...measureJudgments({
          source,
          status,
          judgments,
          basis: {
            ...referenceBasis,
            eligibleResultIds: results
              .filter((result) => !excluded.has(result.id))
              .map((result) => result.id),
            excludedResultIds: [...excluded],
          },
        }),
      };
    };
    return [
      ...missing.map((source) => make(source)),
      ...legacy.map((seed) => make("deterministic", seed)),
      ...saved.map((pass) => ({ ...pass, ...passRates(pass.coverage) })),
    ];
  }
  list(runId: string, details = false): AssessmentPass[] {
    const run = this.db.require("run", runId);
    const originals: AssessmentPass[] = [];
    const scores = this.evaluations.original(runId);
    const sources: AssessmentPass["source"][] = ["deterministic"];
    if (run.manifest.judge.enabled) sources.push("llm");
    if (run.manifest.jevJudge) sources.push("jev");
    const saved = details
      ? this.db.list("assessmentPass", { runId })
      : this.db.assessmentPassObservations(runId);
    for (const source of sources) {
      const passId = `original_${source}_${runId}`;
      if (saved.some((p) => p.id === passId)) continue;
      const configuration = {
        evaluator: run.manifest.evaluator,
        ...(source === "llm" ? { judge: run.manifest.judge } : {}),
        ...(source === "jev" ? { jevJudge: run.manifest.jevJudge } : {}),
      };
      let pass = this.skeleton(
        run,
        source,
        source === "deterministic"
          ? "Original deterministic"
          : source === "llm"
            ? "Original LLM judge"
            : "Original Jev",
        configuration,
        passId,
        false,
      );
      pass.createdAt = run.createdAt;
      pass.judgments = pass.judgments.map((j) => {
        if (j.status === "excluded" || !j.attemptId) return j;
        const assessment = scores.assessments.find(
          (a) => a.resultId === j.resultId,
        );
        if (source === "jev") {
          const record = this.db
            .list("jevAssessment", { resultId: j.resultId })
            .find((a) => a.kind === "original" && a.attemptId === j.attemptId);
          return record ? this.jevJudgment(j, record) : j;
        }
        if (!assessment) return j;
        if (source === "deterministic")
          return {
            ...j,
            status: computedJudgmentStatus("deterministic", {
              deterministic: assessment.deterministic.status,
            }),
            explanation: assessment.deterministic.explanation,
            ...(assessment.deterministic.details
              ? { details: assessment.deterministic.details }
              : {}),
          };
        return {
          ...j,
          status: computedJudgmentStatus("llm", {
            deterministic: assessment.deterministic.status,
            judgeError: assessment.judgeError,
            judgeVerdict: assessment.judge?.verdict,
          }),
          explanation:
            assessment.judgeError ??
            assessment.judge?.explanation ??
            "The judge did not return a verdict.",
          ...(assessment.judgeRequest
            ? { request: assessment.judgeRequest }
            : {}),
          ...(assessment.judgeResponse || assessment.judge
            ? {
                response:
                  assessment.judgeResponse ??
                  jsonSchema.parse(assessment.judge),
              }
            : {}),
          ...((assessment.judgeUsage ?? assessment.judge?.usage)
            ? { usage: assessment.judgeUsage ?? assessment.judge?.usage }
            : {}),
        };
      });
      const terminal = ["completed", "failed", "cancelled"].includes(
        run.status,
      );
      pass = measurePass({
        ...pass,
        status: terminal
          ? "completed"
          : ["paused", "halted", "interrupted"].includes(run.status)
            ? "interrupted"
            : "running",
        ...(terminal ? { finishedAt: run.updatedAt } : {}),
      });
      if (terminal) this.db.insert("assessmentPass", pass);
      originals.push(pass);
    }
    for (const scores of this.db
      .list("scoreSet", { runId })
      .filter((s) => s.kind !== "original" && s.published)) {
      if (saved.some((pass) => pass.id === `scores_${scores.id}`)) continue;
      originals.push(this.snapshotScores(runId, scores.id));
    }
    return [...originals, ...saved]
      .map((pass) => ({ ...pass, ...passRates(pass.coverage) }))
      .map((pass) =>
        details
          ? pass
          : {
              ...pass,
              configuration: {},
              judgments: pass.judgments.map(
                ({
                  request: _request,
                  response: _response,
                  details: _details,
                  ...judgment
                }) => judgment,
              ),
            },
      );
  }
  snapshotScores(runId: string, scoreSetId: string): AssessmentPass {
    const run = this.db.require("run", runId);
    const original = this.evaluations.original(runId);
    const scores =
      scoreSetId === original.id
        ? original
        : this.db.require("scoreSet", scoreSetId);
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
    let pass = this.skeleton(
      run,
      "deterministic",
      `${scores.evaluator.name} (revision ${scores.evaluator.number})`,
      { evaluator: scores.evaluator, referenceBank: scores.referenceBank },
      passId,
      false,
    );
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
    this.db.insert("assessmentPass", pass);
    return pass;
  }
  private jevJudgment(
    j: PassJudgment,
    record: JevAssessmentRecord,
  ): PassJudgment {
    return {
      ...j,
      jevAssessmentId: record.id,
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
  get(runId: string, passId: string): AssessmentPass {
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
    return {
      ...pass,
      ...passRates(pass.coverage),
      judgments: pass.judgments.map((j) => {
        if (!j.jevAssessmentId) return j;
        const record = this.db.get("jevAssessment", j.jevAssessmentId);
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
  snapshot(runId: string, passId: string): AssessmentPass {
    const pass = this.get(runId, passId);
    if (this.db.get("assessmentPass", pass.id)) return pass;
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
    const pass = this.db.insert(
      "assessmentPass",
      this.skeleton(run, input.source, input.name, configuration),
    );
    return this.evaluate(pass, signal);
  }
  async retry(
    input: CommandInput<"runs.retry-assessment">,
    signal: AbortSignal,
  ): Promise<AssessmentPass> {
    const parent = this.get(input.runId, input.passId);
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
            (j.status === "unjudged" && !j.response && !j.jevAssessmentId)),
      )
    )
      throw new AppError(
        "invalid_state",
        "This pass has no failed judgments to retry.",
      );
    const pass = this.db.insert("assessmentPass", {
      ...parent,
      id: id("pass"),
      name: input.name ?? `${parent.name} retry`,
      parentPassId: parent.id,
      status: "running",
      createdAt: now(),
      finishedAt: undefined,
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
            !judgment.response &&
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
            ...(assessed.judgeRequest
              ? { request: assessed.judgeRequest }
              : {}),
            ...(assessed.judgeResponse
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
    let parent = this.get(input.runId, input.parentPassId);
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
