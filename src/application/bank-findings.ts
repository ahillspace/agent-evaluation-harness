import type {
  BankFinding,
  CommandInput,
  CommandResultMap,
} from "../contracts.js";
import { Database } from "../storage/database.js";
import { AssessmentPassService } from "./assessment-passes.js";
import { CatalogService } from "./catalog.js";
import { AppError } from "../domain/errors.js";
import { id, now } from "../domain/identity.js";

export class BankFindingService {
  constructor(
    private readonly db: Database,
    private readonly catalog: CatalogService,
    private readonly passes: AssessmentPassService,
  ) {}
  list(bankId: string): BankFinding[] {
    this.db.require("bank", bankId);
    return this.db.list("bankFinding", { bankId });
  }
  report(input: CommandInput<"banks.report-finding">): BankFinding {
    const bank = this.db.require("bankRevision", input.bankRevisionId);
    if (
      bank.bankId !== input.bankId ||
      !bank.questions.some((q) => q.id === input.questionId)
    )
      throw new AppError(
        "invalid_input",
        "The question does not belong to this bank revision.",
      );
    if (input.runId) {
      const run = this.db.require("run", input.runId);
      if (run.manifest.bank.bankId !== input.bankId)
        throw new AppError(
          "invalid_input",
          "The evidence run belongs to another bank.",
        );
    }
    if (input.resultId) {
      const result = this.db.require("result", input.resultId);
      if (
        result.runId !== input.runId ||
        result.questionId !== input.questionId
      )
        throw new AppError(
          "invalid_input",
          "The evidence result does not match this question and run.",
        );
    }
    if (input.passId) {
      const pass = input.runId
        ? this.passes.get(input.runId, input.passId)
        : undefined;
      if (
        !pass ||
        pass.runId !== input.runId ||
        pass.basis.bankRevisionId !== input.bankRevisionId ||
        (input.resultId &&
          !pass.judgments.some((j) => j.resultId === input.resultId))
      )
        throw new AppError(
          "invalid_input",
          "The assessment evidence does not match this run, result, and reference revision.",
        );
    }
    return this.db.insert("bankFinding", {
      ...input,
      ...(input.passId && input.runId
        ? { passId: this.passes.snapshot(input.runId, input.passId).id }
        : {}),
      note: input.note ?? "",
      id: id("finding"),
      createdAt: now(),
      status: "open",
    });
  }
  async resolve(
    input: CommandInput<"banks.resolve-finding">,
  ): Promise<CommandResultMap["banks.resolve-finding"]> {
    if (input.expected !== undefined && input.exclude)
      throw new AppError(
        "invalid_input",
        "Publish a reference correction or an exclusion in one decision, not both.",
      );
    const finding = this.db.require("bankFinding", input.findingId);
    if (finding.status !== "open")
      throw new AppError(
        "invalid_state",
        "This finding already has a recorded decision.",
      );
    const bank = this.db.require("bank", finding.bankId);
    const revision = this.db.require("bankRevision", bank.latestRevisionId);
    let bankRevision: CommandResultMap["banks.resolve-finding"]["bankRevision"];
    let evaluator: CommandResultMap["banks.resolve-finding"]["evaluator"];
    if (input.status === "accepted" && input.expected !== undefined) {
      const question = revision.questions.find(
        (q) => q.id === finding.questionId,
      );
      if (!question)
        throw new AppError(
          "not_found",
          "This question no longer exists in the latest bank revision.",
        );
      bankRevision = this.catalog.reviseBank({
        bankId: bank.id,
        name: revision.name,
        questions: revision.questions.map((q) =>
          q.id === question.id
            ? { ...q, expected: input.expected!, answerFormat: undefined }
            : q,
        ),
      });
    }
    if (input.status === "accepted" && input.exclude) {
      const current = this.db.require(
        "evaluator",
        bank.activeEvaluatorRevisionId,
      );
      const draft = this.catalog.saveDraft({
        bankId: bank.id,
        name: `Reference review: ${finding.questionId}`,
        settings: {
          ...current.settings,
          questionOverrides: {
            ...current.settings.questionOverrides,
            [finding.questionId]: {
              ...current.settings.questionOverrides[finding.questionId],
              referenceDisposition: "needs_review",
              referenceNote: input.note || finding.title,
            },
          },
        },
      });
      evaluator = await this.catalog.publishDraft(draft.id, true);
    }
    const resolved = this.db.update("bankFinding", {
      ...finding,
      status: input.status,
      resolution: {
        note: input.note ?? "",
        reviewer: input.reviewer ?? "Local reviewer",
        createdAt: now(),
        ...(bankRevision ? { bankRevisionId: bankRevision.id } : {}),
      },
    });
    return {
      finding: resolved,
      ...(bankRevision ? { bankRevision } : {}),
      ...(evaluator ? { evaluator } : {}),
    };
  }
}
