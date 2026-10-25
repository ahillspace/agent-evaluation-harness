import { savedTarget } from "../contracts/targets.js";
import {
  evaluatorSettingsSchema,
  type Bank,
  type BankFinding,
  type BankRevision,
  type BankPublication,
  type BankExportPackage,
  type CommandValue,
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
import { calibrateSettings, validateBankReferences } from "./calibration.js";

export function prepareQuestions(questions: Question[]): Question[] {
  if (
    new Set(questions.map((question) => question.id)).size !== questions.length
  )
    throw new AppError(
      "invalid_input",
      "Question IDs must be unique within a bank.",
    );
  return questions.map((question) => {
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
}

export class CatalogService {
  constructor(private readonly db: Database) {}
  async publishBank(
    input: CommandValue<"banks.publish">,
    findingDecision?: {
      source: BankFinding;
      resolution: NonNullable<BankFinding["resolution"]>;
    },
  ): Promise<BankPublication> {
    const captured = input.bankId
      ? this.db.require("bank", input.bankId)
      : undefined;
    if (!captured && (input.baseRevisionId || input.baseEvaluatorRevisionId))
      throw new AppError(
        "invalid_input",
        "Publication guards require an existing bank.",
      );
    if (captured && (!input.baseRevisionId || !input.baseEvaluatorRevisionId))
      throw new AppError(
        "invalid_input",
        "Publishing an existing bank requires both base revision guards. Reload the bank before publishing.",
      );
    if (
      captured &&
      ((input.baseRevisionId &&
        input.baseRevisionId !== captured.latestRevisionId) ||
        (input.baseEvaluatorRevisionId &&
          input.baseEvaluatorRevisionId !== captured.activeEvaluatorRevisionId))
    )
      throw new AppError(
        "conflict",
        "The published bank or active evaluator changed. Reload before publishing your draft.",
      );
    const questions = prepareQuestions(input.questions);
    const bankId = captured?.id ?? id("bank");
    const revision: BankRevision = {
      id: id("bankrev"),
      bankId,
      number: captured
        ? this.db.require("bankRevision", captured.latestRevisionId).number + 1
        : 1,
      createdAt: now(),
      name: input.name,
      questions,
      digest: digest(questions),
    };
    const calibration = await calibrateSettings(
      revision,
      input.evaluatorSettings,
    );
    if (calibration.passed !== calibration.total)
      throw new AppError(
        "calibration_failed",
        "Bank publication failed calibration. Review the failed examples before publishing.",
      );
    return this.db.transaction(() => {
      if (findingDecision) {
        const currentFinding = this.db.require(
          "bankFinding",
          findingDecision.source.id,
        );
        if (
          currentFinding.bankId !== bankId ||
          currentFinding.status !== "open" ||
          digest(currentFinding) !== digest(findingDecision.source)
        )
          throw new AppError(
            "conflict",
            "The finding decision changed during calibration. Reload the finding before resolving it.",
          );
      }
      const current = captured
        ? this.db.require("bank", captured.id)
        : undefined;
      if (
        current &&
        (current.latestRevisionId !== captured!.latestRevisionId ||
          current.activeEvaluatorRevisionId !==
            captured!.activeEvaluatorRevisionId)
      )
        throw new AppError(
          "conflict",
          "The bank or active evaluator changed during calibration. Review the latest revision before publishing.",
        );
      const previousEvaluators = this.db.list("evaluator", { bankId });
      const evaluatorRevision = this.db.insert(
        "evaluator",
        {
          id: id("evaluator"),
          bankId,
          number:
            Math.max(0, ...previousEvaluators.map((value) => value.number)) + 1,
          createdAt: now(),
          name: input.evaluatorName,
          settings: input.evaluatorSettings,
          digest: digest(input.evaluatorSettings),
          calibration,
        },
        true,
      );
      this.db.insert("bankRevision", revision, true);
      const bank: Bank = {
        ...(current ?? { id: bankId, createdAt: now() }),
        name: input.name,
        latestRevisionId: revision.id,
        activeEvaluatorRevisionId: evaluatorRevision.id,
      };
      if (current) this.db.update("bank", bank);
      else this.db.insert("bank", bank);
      if (findingDecision)
        this.db.update("bankFinding", {
          ...findingDecision.source,
          status: "accepted",
          resolution: {
            ...findingDecision.resolution,
            bankRevisionId: revision.id,
          },
        });
      this.db.append({
        type: "bank.published",
        message: `Published question revision ${revision.number} and grading revision ${evaluatorRevision.number}.`,
        data: {
          bankId,
          bankRevisionId: revision.id,
          evaluatorRevisionId: evaluatorRevision.id,
        },
      });
      return { revision, evaluatorRevision };
    });
  }
  exportPackage(
    input: CommandValue<"banks.export-package">,
  ): BankExportPackage {
    const revision = this.db.require("bankRevision", input.bankRevisionId);
    const bank = this.db.require("bank", revision.bankId);
    const evaluator = this.db.require(
      "evaluator",
      input.evaluatorRevisionId ?? bank.activeEvaluatorRevisionId,
    );
    if (evaluator.bankId !== bank.id)
      throw new AppError(
        "incompatible_basis",
        "The evaluator belongs to a different question bank.",
      );
    validateBankReferences(revision, evaluator.settings);
    const profileId =
      input.jevProfileRevisionId ?? bank.activeJevProfileRevisionId;
    const profile = profileId
      ? this.db.require("jevProfile", profileId)
      : undefined;
    if (profile && profile.bankId !== bank.id)
      throw new AppError(
        "incompatible_basis",
        "The Jev profile belongs to a different question bank.",
      );
    return {
      format: "agent-evaluation-harness/question-bank",
      version: 1,
      name: revision.name,
      questions: revision.questions,
      evaluator: { name: evaluator.name, settings: evaluator.settings },
      ...(profile
        ? { jevProfile: { name: profile.name, settings: profile.settings } }
        : {}),
      source: {
        bankRevisionId: revision.id,
        evaluatorRevisionId: evaluator.id,
        ...(profile ? { jevProfileRevisionId: profile.id } : {}),
      },
    };
  }
  async createBank(input: CommandValue<"banks.create">): Promise<BankRevision> {
    const publication = await this.publishBank({
      name: input.name,
      questions: input.questions,
      evaluatorName: "Default evaluator",
      evaluatorSettings: input.evaluator ?? evaluatorSettingsSchema.parse({}),
    });
    return publication.revision;
  }
  async reviseBank(input: CommandValue<"banks.revise">): Promise<BankRevision> {
    const bank = this.db.require("bank", input.bankId);
    const evaluator = this.db.require(
      "evaluator",
      bank.activeEvaluatorRevisionId,
    );
    const publication = await this.publishBank({
      ...input,
      evaluatorName: evaluator.name,
      evaluatorSettings: evaluator.settings,
    });
    return publication.revision;
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
