import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  jsonSchema,
  judgeVerdictSchema,
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
import { evidenceSupports } from "../domain/evidence-requirements.js";
import { JevService } from "./jev.js";

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
export function measurePass(pass: AssessmentPass): AssessmentPass {
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
    ...pass,
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
  }
  private skeleton(
    run: RunRecord,
    source: AssessmentPass["source"],
    name: string,
    configuration: AssessmentPass["configuration"],
    passId = id("pass"),
  ): AssessmentPass {
    const evaluator = configuration.evaluator ?? run.manifest.evaluator;
    const questions =
      configuration.referenceBank?.questions ?? run.manifest.questions;
    const results = this.db.list("result", { runId: run.id });
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
      judgments: results.map((r) => ({
        resultId: r.id,
        ...(r.completedAttemptId
          ? {
              attemptId: r.completedAttemptId,
              evidenceHash: this.db.require("attempt", r.completedAttemptId)
                .evidenceHash,
            }
          : {}),
        status: excluded.includes(r.id) ? "excluded" : "unjudged",
        explanation: excluded.includes(r.id)
          ? "Excluded by the selected reference policy."
          : r.completedAttemptId
            ? "Assessment pending."
            : `Execution ${r.status}; no sealed answer.`,
      })),
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
            status:
              assessment.deterministic.status === "unavailable"
                ? "unjudged"
                : assessment.deterministic.status === "unscorable"
                  ? "excluded"
                  : assessment.deterministic.status,
            explanation: assessment.deterministic.explanation,
            ...(assessment.deterministic.details
              ? { details: assessment.deterministic.details }
              : {}),
          };
        return {
          ...j,
          status: assessment.judgeError
            ? "error"
            : assessment.judge?.verdict === true
              ? "correct"
              : assessment.judge?.verdict === false
                ? "incorrect"
                : "unjudged",
          explanation:
            assessment.judgeError ??
            assessment.judge?.explanation ??
            "The judge did not return a verdict.",
          ...(assessment.judgeRequest
            ? { request: assessment.judgeRequest }
            : {}),
          ...(assessment.judge
            ? {
                response:
                  assessment.judgeResponse ??
                  jsonSchema.parse(assessment.judge),
              }
            : {}),
          ...(assessment.judge?.usage ? { usage: assessment.judge.usage } : {}),
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
      const passId = `scores_${scores.id}`;
      if (saved.some((p) => p.id === passId)) continue;
      let pass = this.skeleton(
        run,
        "deterministic",
        `${scores.evaluator.name} (revision ${scores.evaluator.number})`,
        { evaluator: scores.evaluator, referenceBank: scores.referenceBank },
        passId,
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
            status:
              status === "unavailable"
                ? "unjudged"
                : status === "unscorable"
                  ? "excluded"
                  : status,
            explanation: assessment.deterministic.explanation,
            ...(assessment.deterministic.details
              ? { details: assessment.deterministic.details }
              : {}),
          };
        }),
      };
      pass = measurePass(pass);
      this.db.insert("assessmentPass", pass);
      originals.push(pass);
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
  private jevJudgment(
    j: PassJudgment,
    record: JevAssessmentRecord,
  ): PassJudgment {
    const answer = record.checks?.answer;
    const answerEligible =
      record.status === "completed" &&
      answer !== undefined &&
      answer.confidence >= record.criteria.confidenceThreshold;
    return {
      ...j,
      jevAssessmentId: record.id,
      status:
        record.status === "error"
          ? "error"
          : record.status === "pending"
            ? "unjudged"
            : answerEligible && answer.choice === "acceptable"
              ? "correct"
              : answerEligible && answer.choice === "incorrect"
                ? "incorrect"
                : "unjudged",
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
          if (
            !evidenceSupports(
              attempt.output.evidenceScope ?? "internal-activity",
              pass.configuration.judge?.evidenceRequirement ?? "unspecified",
            )
          )
            throw new AppError(
              "unsupported_evidence",
              "The selected judge requires evidence unavailable in this run.",
            );
          const question = (
            pass.configuration.referenceBank?.questions ??
            run.manifest.questions
          ).find((q) => q.id === result.questionId)!;
          const { expected, ...publicQuestion } = question;
          const request = jsonSchema.parse({
            configuration: pass.configuration.judge,
            question: publicQuestion,
            expected,
            answer: attempt.output.answer,
          });
          pass = {
            ...pass,
            judgments: pass.judgments.map((j, i) =>
              i === index ? { ...j, request, judgmentId } : j,
            ),
          };
          this.db.update("assessmentPass", pass);
          const artifactDirectory = join(
            this.directory,
            "runs",
            run.id,
            "assessments",
            pass.id,
            attempt.id,
          );
          await mkdir(artifactDirectory, { recursive: true });
          const verdict = judgeVerdictSchema.parse(
            await this.runtime.judge({
              observationLevel: attempt.output.evidenceScope,
              configuration: pass.configuration.judge!,
              question: publicQuestion,
              expected,
              answer: attempt.output.answer,
              artifactDirectory,
              timeoutMs: run.manifest.limits.timeoutMs,
              signal,
            }),
          );
          next = {
            ...judgment,
            judgmentId,
            request,
            response: jsonSchema.parse(verdict),
            status:
              verdict.verdict === true
                ? "correct"
                : verdict.verdict === false
                  ? "incorrect"
                  : "unjudged",
            explanation:
              verdict.explanation ?? "The judge returned no explanation.",
            ...(verdict.usage ? { usage: verdict.usage } : {}),
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
  review(input: CommandInput<"runs.review-assessment">): AssessmentPass {
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
        createdAt: now(),
      };
      if (override.note) judgment.explanation = override.note;
    }
    parent = this.snapshot(input.runId, parent.id);
    const excludedResultIds = judgments
      .filter((j) => j.status === "excluded")
      .map((j) => j.resultId);
    const pass = measurePass({
      ...parent,
      id: id("pass"),
      name: input.name,
      source: "human",
      parentPassId: parent.id,
      status: "completed",
      createdAt: now(),
      finishedAt: now(),
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
    this.select(input.runId, pass.id);
    return pass;
  }
}
