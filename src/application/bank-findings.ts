import type {
  BankFinding,
  CommandInput,
  CommandResultMap,
} from "../contracts.js";
import { Database } from "../storage/database.js";
import { AssessmentPassService } from "./assessment-passes.js";
import { CatalogService } from "./catalog.js";
import { AppError } from "../domain/errors.js";
import { digest, id, now } from "../domain/identity.js";

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
    const resolution = {
      note: input.note ?? "",
      reviewer: input.reviewer ?? "Local reviewer",
      createdAt: now(),
    };
    if (
      input.status === "accepted" &&
      (input.expected !== undefined || input.exclude)
    ) {
      const bank = this.db.require("bank", finding.bankId);
      const revision = this.db.require("bankRevision", bank.latestRevisionId);
      const source = this.db.require("bankRevision", finding.bankRevisionId);
      const sourceQuestion = source.questions.find(
        (question) => question.id === finding.questionId,
      );
      const question = revision.questions.find(
        (question) => question.id === finding.questionId,
      );
      if (
        !sourceQuestion ||
        !question ||
        digest({ ...sourceQuestion, tags: undefined }) !==
          digest({ ...question, tags: undefined })
      )
        throw new AppError(
          "incompatible_basis",
          "This question or its reference changed after the finding was reported. Review the latest question and report a new finding before applying a correction or exclusion.",
        );
      const current = this.db.require(
        "evaluator",
        bank.activeEvaluatorRevisionId,
      );
      const publication = await this.catalog.publishBank(
        {
          bankId: bank.id,
          baseRevisionId: revision.id,
          baseEvaluatorRevisionId: current.id,
          name: revision.name,
          questions:
            input.expected !== undefined
              ? revision.questions.map((item) =>
                  item.id === question.id
                    ? {
                        ...item,
                        expected: input.expected!,
                        answerFormat: undefined,
                      }
                    : item,
                )
              : revision.questions,
          evaluatorName: current.name,
          evaluatorSettings: input.exclude
            ? {
                ...current.settings,
                questionOverrides: {
                  ...current.settings.questionOverrides,
                  [finding.questionId]: {
                    ...current.settings.questionOverrides[finding.questionId],
                    referenceDisposition: "needs_review",
                    referenceNote: input.note || finding.title,
                  },
                },
              }
            : current.settings,
        },
        { source: finding, resolution },
      );
      return {
        finding: this.db.require("bankFinding", finding.id),
        bankRevision: publication.revision,
        evaluator: publication.evaluatorRevision,
      };
    }
    const resolved = this.db.update("bankFinding", {
      ...finding,
      status: input.status,
      resolution,
    });
    return { finding: resolved };
  }
}
