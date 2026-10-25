import type {
  Assessment,
  BankRevision,
  AttemptRecord,
  EvaluationPreview,
  EvaluatorDraft,
  CommandValue,
  CalibrationReport,
  Question,
  Verdict,
  EvaluatorRevision,
  ResultRecord,
  RunRecord,
  ScoreSet,
  ScoreSetSummary,
} from "../contracts.js";
import { AnswerSources } from "./answer-sources.js";
import { AppError } from "../domain/errors.js";
import { digest, id, now } from "../domain/identity.js";
import { grade } from "../evaluation/scoring.js";
import { Database } from "../storage/database.js";
import { calibrateSettings, validateQuestionPolicy } from "./calibration.js";
import { prepareQuestions } from "./catalog.js";
import { savedTarget } from "../contracts/targets.js";
import {
  evaluatorEvidenceRequirement,
  evidenceSupports,
} from "../domain/evidence-requirements.js";

function scoredAssessments(assessments: Assessment[]): Assessment[] {
  return assessments.filter((a) =>
    ["correct", "incorrect"].includes(a.deterministic.status),
  );
}
export function gradedCount(assessments: Assessment[]): number {
  return scoredAssessments(assessments).length;
}
export function unscorableCount(assessments: Assessment[]): number {
  return assessments.filter(
    (item) => item.deterministic.status === "unscorable",
  ).length;
}
export function accuracy(assessments: Assessment[]): number | null {
  const valid = scoredAssessments(assessments);
  return valid.length
    ? valid.filter((a) => a.deterministic.status === "correct").length /
        valid.length
    : null;
}
export class EvaluationService {
  constructor(private readonly db: Database) {}
  async checkAnswer(
    input: CommandValue<"banks.check-answer">,
  ): Promise<Verdict> {
    const [question] = prepareQuestions([input.question]);
    validateQuestionPolicy(question!, input.settings);
    const effective = {
      ...input.settings,
      ...input.settings.questionOverrides[question!.id],
    };
    return grade(
      question!.expected,
      input.answer,
      effective,
      question!.answerFormat,
    );
  }
  private draftReference(
    questions: Question[],
    bankId = "draft",
    name = "Question bank draft",
  ): BankRevision {
    const prepared = prepareQuestions(questions);
    const hash = digest(prepared);
    return {
      id: `draft_${hash}`,
      bankId,
      number: 0,
      name,
      createdAt: now(),
      questions: prepared,
      digest: hash,
    };
  }
  async calibrateDraft(
    input: CommandValue<"banks.calibrate-draft">,
  ): Promise<CalibrationReport> {
    return calibrateSettings(
      this.draftReference(input.questions),
      input.settings,
    );
  }
  async previewDraft(
    input: CommandValue<"banks.preview-draft">,
  ): Promise<EvaluationPreview> {
    const bank = this.db.require("bank", input.bankId);
    const reference = this.draftReference(input.questions, bank.id, bank.name);
    const createdAt = now();
    const draft: EvaluatorDraft = {
      id: `preview_${digest({ questions: reference.questions, settings: input.settings })}`,
      bankId: bank.id,
      name: "Question bank draft",
      settings: input.settings,
      createdAt,
      updatedAt: createdAt,
    };
    return this.previewSettings(draft, input.runIds, reference);
  }
  summaries(runId: string): ScoreSetSummary[] {
    const saved = this.db.scoreSetSummaries(runId);
    if (!saved.some((scores) => scores.kind === "original")) {
      const run = this.db.require("run", runId);
      const {
        settings: _settings,
        calibration,
        ...metadata
      } = run.manifest.evaluator;
      const evaluator = {
        ...metadata,
        ...(calibration
          ? {
              calibration: {
                bankRevisionId: calibration.bankRevisionId,
                total: calibration.total,
                passed: calibration.passed,
              },
            }
          : {}),
      };
      saved.unshift({
        id: `original_${runId}`,
        runId,
        evaluator,
        createdAt: run.createdAt,
        kind: "original",
        published: false,
        assessments: this.db.assessmentSummaries(runId),
      });
    }
    return saved;
  }
  async recover(): Promise<void> {
    for (const result of this.db.list("result", { status: "completed" })) {
      if (
        !result.completedAttemptId ||
        this.db
          .list("assessment", { resultId: result.id })
          .some(
            (assessment) => assessment.attemptId === result.completedAttemptId,
          )
      )
        continue;
      const run = this.db.require("run", result.runId);
      const attempt = this.db.require("attempt", result.completedAttemptId);
      const assessment = await this.assess(run, result, attempt);
      if (run.manifest.judge.enabled)
        assessment.judgeRequest = this.db.judgeRequest(attempt.id);
      if (run.manifest.judge.enabled)
        assessment.judgeError =
          "The engine stopped before the judge assessment was saved. Deterministic grading was recovered without another model call.";
      this.db.insert(
        "assessment",
        { ...assessment, id: id("assessment"), runId: run.id },
        true,
      );
      this.db.append({
        runId: run.id,
        attemptId: attempt.id,
        type: "evaluation.recovered",
        message: "Recovered deterministic grading from sealed evidence.",
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    for (const run of this.db.list("run", {
      status: ["completed", "cancelled"],
    }))
      this.sealOriginal(run.id);
  }
  async assess(
    run: RunRecord,
    result: ResultRecord,
    attempt: AttemptRecord,
    evaluator = run.manifest.evaluator,
    referenceBank?: BankRevision,
  ): Promise<Assessment> {
    const question = (referenceBank?.questions ?? run.manifest.questions).find(
      (q) => q.id === result.questionId,
    );
    if (!question || !attempt.output || attempt.status !== "completed")
      throw new AppError(
        "evidence_unavailable",
        "The result has no completed, sealed answer.",
      );
    if (attempt.evidenceHash !== digest(attempt.output))
      throw new AppError(
        "evidence_integrity",
        "The saved answer does not match its sealed evidence hash.",
      );
    const effective = {
      ...evaluator.settings,
      ...evaluator.settings.questionOverrides[question.id],
    };
    const observation =
      attempt.output.evidenceScope ??
      (savedTarget(run.manifest).kind === "external"
        ? "answer-only"
        : "internal-activity");
    return {
      resultId: result.id,
      attemptId: attempt.id,
      deterministic: evidenceSupports(
        observation,
        evaluatorEvidenceRequirement(effective),
      )
        ? await grade(
            question.expected,
            attempt.output.answer,
            effective,
            question.answerFormat,
          )
        : {
            status: "unavailable",
            explanation:
              "The evaluator requires unavailable or unspecified evidence. Publish an answer-compatible revision before rescoring this answer.",
          },
    };
  }
  original(runId: string): ScoreSet {
    const saved = this.db
      .list("scoreSet", { runId })
      .find((s) => s.kind === "original");
    if (saved) return saved;
    const run = this.db.require("run", runId);
    return {
      id: `original_${runId}`,
      runId,
      evaluator: run.manifest.evaluator,
      createdAt: run.createdAt,
      kind: "original",
      assessments: this.db.list("assessment", { runId }),
      published: false,
    };
  }
  sealOriginal(runId: string): void {
    const original = this.original(runId);
    if (original.published) return;
    this.db.insert("scoreSet", { ...original, published: true }, true);
  }
  async rescore(
    runId: string,
    evaluatorRevisionId: string,
    publish: boolean,
    bankRevisionId?: string,
  ): Promise<ScoreSet> {
    const run = this.db.require("run", runId);
    const evaluator = this.db.require("evaluator", evaluatorRevisionId);
    if (evaluator.bankId !== run.manifest.bank.bankId)
      throw new AppError(
        "incompatible_basis",
        "The evaluator belongs to a different question bank.",
      );
    const referenceBank = this.referenceBasis(run, bankRevisionId);
    const assessments = await this.assessSaved(run, evaluator, referenceBank);
    const scoreSet = this.db.insert("scoreSet", {
      id: id("scores"),
      runId,
      evaluator,
      ...(referenceBank ? { referenceBank } : {}),
      createdAt: now(),
      kind: "rescore",
      assessments,
      published: publish,
    });
    this.db.append({
      runId,
      type: "evaluation.rescored",
      message: `Saved scoring under evaluator revision ${evaluator.number}.`,
      data: { scoreSetId: scoreSet.id, published: publish },
    });
    return scoreSet;
  }
  private async assessSaved(
    run: RunRecord,
    evaluator: EvaluatorRevision,
    referenceBank?: BankRevision,
  ): Promise<Assessment[]> {
    const results = this.db
      .list("result", { runId: run.id })
      .filter((r) => new AnswerSources(this.db).source(r));
    if (!results.length)
      throw new AppError(
        "evidence_unavailable",
        "This run has no completed answers to evaluate.",
      );
    const assessments: Assessment[] = [];
    for (const result of results) {
      assessments.push(
        await this.assess(
          run,
          result,
          new AnswerSources(this.db).verify(
            result,
            new AnswerSources(this.db).source(result)!,
          ),
          evaluator,
          referenceBank,
        ),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return assessments;
  }
  private referenceBasis(
    run: RunRecord,
    bankRevisionId?: string,
    inlineBank?: BankRevision,
  ): BankRevision | undefined {
    if (!bankRevisionId && !inlineBank) return undefined;
    const bank = inlineBank ?? this.db.require("bankRevision", bankRevisionId!);
    if (bank.bankId !== run.manifest.bank.bankId)
      throw new AppError(
        "incompatible_basis",
        "The reference revision belongs to a different question bank.",
      );
    for (const original of run.manifest.questions) {
      const reference = bank.questions.find(
        (question) => question.id === original.id,
      );
      if (
        !reference ||
        reference.text !== original.text ||
        reference.context !== original.context
      )
        throw new AppError(
          "incompatible_basis",
          `Question ${original.id} is missing or its text or context changed. Corrected references must describe the original task.`,
        );
    }
    return bank;
  }
  async calibrate(draftId: string, bankRevisionId?: string) {
    const draft = this.db.require("evaluatorDraft", draftId);
    const bank = this.db.require("bank", draft.bankId);
    const reference = this.db.require(
      "bankRevision",
      bankRevisionId ?? bank.latestRevisionId,
    );
    if (reference.bankId !== draft.bankId)
      throw new AppError(
        "incompatible_basis",
        "The calibration reference belongs to a different question bank.",
      );
    return calibrateSettings(reference, draft.settings);
  }
  async preview(
    draftId: string,
    runIds: string[],
    bankRevisionId?: string,
  ): Promise<EvaluationPreview> {
    const draft = this.db.require("evaluatorDraft", draftId);
    const reference = bankRevisionId
      ? this.db.require("bankRevision", bankRevisionId)
      : undefined;
    return this.previewSettings(draft, runIds, reference);
  }
  private async previewSettings(
    draft: EvaluatorDraft,
    runIds: string[],
    reference?: BankRevision,
  ): Promise<EvaluationPreview> {
    const evaluator: EvaluatorRevision = {
      ...draft,
      number: 0,
      digest: digest(draft.settings),
    };
    const runs = [];
    for (const runId of runIds) {
      const run = this.db.require("run", runId);
      if (run.manifest.bank.bankId !== draft.bankId)
        throw new AppError(
          "incompatible_basis",
          "Preview runs must belong to the draft question bank.",
        );
      const referenceBank = this.referenceBasis(run, reference?.id, reference);
      for (const question of referenceBank?.questions ?? run.manifest.questions)
        validateQuestionPolicy(question, draft.settings);
      const assessments = await this.assessSaved(run, evaluator, referenceBank);
      const previous = this.original(runId).assessments;
      runs.push({
        runId,
        name: run.name,
        assessments,
        rows: assessments.map((assessment) => {
          const result = this.db.require("result", assessment.resultId);
          const question = (
            referenceBank?.questions ?? run.manifest.questions
          ).find((item) => item.id === result.questionId)!;
          const before = previous.find(
            (item) => item.resultId === assessment.resultId,
          )?.deterministic;
          return {
            resultId: result.id,
            questionId: question.id,
            question: question.text,
            expected: question.expected,
            answer: this.db.require("attempt", assessment.attemptId).output!
              .answer,
            repetition: result.repetition,
            before,
            after: assessment.deterministic,
            changed: digest(before) !== digest(assessment.deterministic),
          };
        }),
        changes: assessments
          .map((assessment) => ({
            resultId: assessment.resultId,
            before: previous.find((a) => a.resultId === assessment.resultId)
              ?.deterministic,
            after: assessment.deterministic,
          }))
          .filter((change) => digest(change.before) !== digest(change.after)),
      });
    }
    const calibrationReference =
      reference ??
      this.db.require(
        "bankRevision",
        this.db.require("bank", draft.bankId).latestRevisionId,
      );
    const calibration = await calibrateSettings(
      calibrationReference,
      draft.settings,
    );
    const referenceBank = reference;
    const summary = referenceBank
      ? (({ questions: _questions, ...metadata }) => metadata)(referenceBank)
      : undefined;
    return {
      draft,
      runs,
      calibration,
      ...(summary ? { referenceBank: summary } : {}),
    };
  }
  publish(runId: string, scoreSetId: string): ScoreSet {
    const scores = this.db.require("scoreSet", scoreSetId);
    if (scores.runId !== runId)
      throw new AppError(
        "invalid_input",
        "This score set belongs to a different run.",
      );
    if (scores.published) return scores;
    return this.db.update("scoreSet", { ...scores, published: true });
  }
}
