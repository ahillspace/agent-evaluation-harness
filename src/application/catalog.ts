import { savedTarget } from "../contracts/targets.js";
import {
  evaluatorSettingsSchema,
  type Bank,
  type BankRevision,
  type Blueprint,
  type EvaluatorDraft,
  type EvaluatorRevision,
  type EvaluatorSettings,
  type Question,
} from "../contracts.js";
import { AppError } from "../domain/errors.js";
import { digest, id, now } from "../domain/identity.js";
import { Database } from "../storage/database.js";
import {
  deriveAnswerFormat,
  referenceAnswerValue,
  validateSubmittedAnswer,
} from "../contracts/answer-format.js";
import { calibrateSettings, validateBankPolicies } from "./calibration.js";

export class CatalogService {
  constructor(private readonly db: Database) {}
  private checkQuestions(questions: Question[]): void {
    if (new Set(questions.map((q) => q.id)).size !== questions.length)
      throw new AppError(
        "invalid_input",
        "Question IDs must be unique within a bank.",
      );
  }
  createBank(input: {
    name: string;
    questions: Question[];
    evaluator?: EvaluatorSettings;
  }): BankRevision {
    this.checkQuestions(input.questions);
    return this.db.transaction(() => {
      const bankId = id("bank");
      const evaluator: EvaluatorRevision = {
        id: id("evaluator"),
        bankId,
        number: 1,
        createdAt: now(),
        name: "Default evaluator",
        settings: input.evaluator ?? evaluatorSettingsSchema.parse({}),
        digest: "",
      };
      evaluator.digest = digest(evaluator.settings);
      validateBankPolicies({ questions: input.questions }, evaluator.settings);
      this.db.insert("evaluator", evaluator, true);
      const revision = this.makeRevision(
        bankId,
        1,
        input.name,
        input.questions,
      );
      this.db.insert("bank", {
        id: bankId,
        name: input.name,
        createdAt: now(),
        latestRevisionId: revision.id,
        activeEvaluatorRevisionId: evaluator.id,
      });
      return revision;
    });
  }
  private makeRevision(
    bankId: string,
    number: number,
    name: string,
    questions: Question[],
  ): BankRevision {
    const publishedQuestions = questions.map((question) => {
      try {
        const derived = deriveAnswerFormat(question.expected);
        if (
          question.answerFormat &&
          derived &&
          question.answerFormat.type === "table" &&
          derived.type === "table" &&
          (question.answerFormat.columns.length !== derived.columns.length ||
            question.answerFormat.columns.some((column, index) => {
              const reference = derived.columns[index]!;
              return (
                column.name !== reference.name ||
                column.type !== reference.type ||
                (reference.nullable && !column.nullable)
              );
            }))
        )
          throw new AppError(
            "invalid_input",
            `Question ${question.id} has a public answer format that conflicts with its reference columns. Update both declarations before publishing.`,
          );
        if (question.answerFormat) {
          const value = referenceAnswerValue(question.expected);
          if (!validateSubmittedAnswer(question.answerFormat, value).ok)
            throw new AppError(
              "invalid_input",
              `Question ${question.id} has a public answer format incompatible with its reference answer.`,
            );
        }
        // Reference nullability is a grading rule, not an inferred source constraint.
        const answerFormat =
          question.answerFormat ??
          (derived?.type === "table"
            ? {
                ...derived,
                columns: derived.columns.map((column) => ({
                  ...column,
                  nullable: true,
                })),
              }
            : derived);
        return answerFormat ? { ...question, answerFormat } : question;
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(
          "invalid_input",
          `Question ${question.id} has invalid table column metadata. Declare unique column names and supported types before publication.`,
        );
      }
    });
    return this.db.insert(
      "bankRevision",
      {
        id: id("bankrev"),
        bankId,
        number,
        createdAt: now(),
        name,
        questions: publishedQuestions,
        digest: digest(publishedQuestions),
      },
      true,
    );
  }
  reviseBank(input: {
    bankId: string;
    name: string;
    questions: Question[];
  }): BankRevision {
    this.checkQuestions(input.questions);
    return this.db.transaction(() => {
      const bank = this.db.require("bank", input.bankId);
      const previous = this.db.require("bankRevision", bank.latestRevisionId);
      const evaluator = this.db.require(
        "evaluator",
        bank.activeEvaluatorRevisionId,
      );
      validateBankPolicies({ questions: input.questions }, evaluator.settings);
      const revision = this.makeRevision(
        bank.id,
        previous.number + 1,
        input.name,
        input.questions,
      );
      this.db.update("bank", {
        ...bank,
        name: input.name,
        latestRevisionId: revision.id,
      });
      return revision;
    });
  }
  saveDraft(input: {
    bankId: string;
    draftId?: string;
    name: string;
    settings: EvaluatorSettings;
  }): EvaluatorDraft {
    this.db.require("bank", input.bankId);
    if (input.draftId) {
      const existing = this.db.require("evaluatorDraft", input.draftId);
      if (existing.bankId !== input.bankId)
        throw new AppError(
          "invalid_input",
          "The draft belongs to a different bank.",
        );
      return this.db.update("evaluatorDraft", {
        ...existing,
        name: input.name,
        settings: input.settings,
        updatedAt: now(),
      });
    }
    return this.db.insert("evaluatorDraft", {
      id: id("draft"),
      bankId: input.bankId,
      name: input.name,
      settings: input.settings,
      createdAt: now(),
      updatedAt: now(),
    });
  }
  async publishDraft(
    draftId: string,
    activate: boolean,
  ): Promise<EvaluatorRevision> {
    const capturedDraft = this.db.require("evaluatorDraft", draftId);
    const capturedBank = this.db.require("bank", capturedDraft.bankId);
    const reference = this.db.require(
      "bankRevision",
      capturedBank.latestRevisionId,
    );
    const calibration = await calibrateSettings(
      reference,
      capturedDraft.settings,
    );
    if (calibration.passed !== calibration.total)
      throw new AppError(
        "calibration_failed",
        "Evaluator publication failed calibration. Review the failed examples before publishing.",
      );
    return this.db.transaction(() => {
      const draft = this.db.require("evaluatorDraft", draftId);
      const bank = this.db.require("bank", draft.bankId);
      if (
        bank.latestRevisionId !== reference.id ||
        digest(draft) !== digest(capturedDraft)
      )
        throw new AppError(
          "conflict",
          "The bank or evaluator draft changed during calibration. Run publication again against the latest revision.",
        );
      const revisions = this.db.list("evaluator", { bankId: draft.bankId });
      const revision = this.db.insert(
        "evaluator",
        {
          id: id("evaluator"),
          bankId: draft.bankId,
          number: Math.max(0, ...revisions.map((r) => r.number)) + 1,
          createdAt: now(),
          name: draft.name,
          settings: draft.settings,
          digest: digest(draft.settings),
          calibration,
        },
        true,
      );
      if (activate) this.activate(draft.bankId, revision.id);
      return revision;
    });
  }
  activate(bankId: string, evaluatorRevisionId: string): Bank {
    const bank = this.db.require("bank", bankId);
    const evaluator = this.db.require("evaluator", evaluatorRevisionId);
    if (evaluator.bankId !== bankId)
      throw new AppError(
        "invalid_input",
        "The evaluator belongs to a different bank.",
      );
    this.db.append({
      type: "evaluator.activated",
      message: `Activated evaluator revision ${evaluator.number}.`,
      data: { bankId, evaluatorRevisionId },
    });
    return this.db.update("bank", {
      ...bank,
      activeEvaluatorRevisionId: evaluatorRevisionId,
    });
  }
  saveBlueprint(name: string, runId: string): Blueprint {
    const run = this.db.require("run", runId);
    return this.db.insert("blueprint", {
      id: id("blueprint"),
      name,
      createdAt: now(),
      target: savedTarget(run.manifest),
      sourceRunId: run.id,
      repetitions: run.manifest.repetitions,
      limits: run.manifest.limits,
      judge: run.manifest.judge,
      ...(run.manifest.jevJudge ? { jevJudge: run.manifest.jevJudge } : {}),
    });
  }
}
