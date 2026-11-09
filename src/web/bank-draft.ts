import { z } from "zod";
import {
  evaluatorSettingsSchema,
  jevProfileSettingsSchema,
  questionSchema,
  type BankDetail,
  type EvaluatorSettings,
  type JevProfileSettings,
  type Question,
} from "../contracts.js";
import type { BankImport } from "./bank-import.js";

export interface BankDraft {
  name: string;
  questions: Question[];
  evaluatorName: string;
  settings: EvaluatorSettings;
  baseRevisionId?: string;
  baseEvaluatorRevisionId?: string;
  importedJevProfile?: { name: string; settings: JevProfileSettings };
}
export interface BankAuthoringState {
  draft: BankDraft;
  importDialog: { error: unknown } | null;
}
export type BankAuthoringAction =
  | { type: "update"; update: BankDraft | ((current: BankDraft) => BankDraft) }
  | { type: "import-dialog"; open: boolean }
  | {
      type: "import";
      value: BankImport;
      mode: "replace" | "append";
      importName: boolean;
    };

export function bankAuthoringReducer(
  state: BankAuthoringState,
  action: BankAuthoringAction,
): BankAuthoringState {
  switch (action.type) {
    case "update":
      return {
        ...state,
        draft:
          typeof action.update === "function"
            ? action.update(state.draft)
            : action.update,
      };
    case "import-dialog":
      return { ...state, importDialog: action.open ? { error: null } : null };
    case "import": {
      try {
        return {
          draft: importBankDraft(state.draft, action),
          importDialog: null,
        };
      } catch (error) {
        return { ...state, importDialog: { error } };
      }
    }
  }
}

function importBankDraft(
  draft: BankDraft,
  { value, mode, importName }: Extract<BankAuthoringAction, { type: "import" }>,
): BankDraft {
  const ids = new Set(
    mode === "append" ? draft.questions.map((item) => item.id) : [],
  );
  for (const question of value.questions) {
    if (ids.has(question.id))
      throw new Error(
        `Question ID ${question.id} already exists. Choose replacement or change duplicate IDs before importing.`,
      );
    ids.add(question.id);
  }
  return {
    ...draft,
    name: importName && !draft.name && value.name ? value.name : draft.name,
    questions:
      mode === "append"
        ? [...draft.questions, ...value.questions]
        : value.questions,
    evaluatorName:
      mode === "replace" && value.evaluator
        ? value.evaluator.name
        : draft.evaluatorName,
    settings:
      mode === "replace" && value.evaluator
        ? value.evaluator.settings
        : {
            ...draft.settings,
            questionOverrides: {
              ...(mode === "append" ? draft.settings.questionOverrides : {}),
              ...(value.evaluator?.settings.questionOverrides ?? {}),
            },
            calibrationExamples:
              mode === "append"
                ? [
                    ...(draft.settings.calibrationExamples ?? []),
                    ...(value.evaluator?.settings.calibrationExamples ?? []),
                  ]
                : [],
          },
    ...(value.jevProfile ? { importedJevProfile: value.jevProfile } : {}),
  };
}
const draftComparisonSchema = evaluatorSettingsSchema
  .innerType()
  .omit({ questionOverrides: true, calibrationExamples: true })
  .extend({
    absoluteTolerance: z.number(),
    relativeTolerance: z.number(),
    decimalPlaces: z.number().optional(),
    answerPath: z.string().optional(),
    sortOrder: z
      .array(
        z
          .object({ column: z.string(), direction: z.enum(["asc", "desc"]) })
          .strict(),
      )
      .optional(),
    referenceNote: z.string().optional(),
    code: z.string().optional(),
  });
const draftSettingsSchema = draftComparisonSchema.extend({
  questionOverrides: z.record(draftComparisonSchema.partial()),
  calibrationExamples:
    evaluatorSettingsSchema.innerType().shape.calibrationExamples,
});
const draftSchema = z.object({
  name: z.string(),
  questions: z.array(
    questionSchema.extend({ id: z.string(), text: z.string() }),
  ),
  evaluatorName: z.string(),
  settings: draftSettingsSchema,
  baseRevisionId: z.string().optional(),
  baseEvaluatorRevisionId: z.string().optional(),
  importedJevProfile: z
    .object({ name: z.string(), settings: jevProfileSettingsSchema })
    .optional(),
});
export function bankDraftKey(workspaceId: string | undefined, bankId: string) {
  return workspaceId
    ? `aeh.bank-draft.v1:${encodeURIComponent(workspaceId)}:${encodeURIComponent(bankId)}`
    : undefined;
}
export function sameDraftValue(left: unknown, right: unknown): boolean {
  const canonical = (draft: unknown) =>
    JSON.stringify(draft, (_key, value: unknown) => {
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        const record = value as Record<string, unknown>;
        return Object.fromEntries(
          Object.keys(record)
            .sort()
            .map((key) => [key, record[key]]),
        );
      }
      return value;
    });
  return canonical(left) === canonical(right);
}
export function bankDraftsEqual(left: BankDraft, right: BankDraft): boolean {
  return sameDraftValue(left, right);
}
export function initialBankDraft(detail?: BankDetail): BankDraft {
  const revision = detail?.revisions.find(
    (item) => item.id === detail.bank.latestRevisionId,
  );
  const evaluator = detail?.evaluatorRevisions.find(
    (item) => item.id === detail.bank.activeEvaluatorRevisionId,
  );
  return {
    name: revision?.name ?? "",
    questions: structuredClone(revision?.questions ?? []),
    evaluatorName: evaluator?.name ?? "Answer rules",
    settings: structuredClone(
      evaluator?.settings ?? evaluatorSettingsSchema.parse({}),
    ),
    ...(revision ? { baseRevisionId: revision.id } : {}),
    ...(evaluator ? { baseEvaluatorRevisionId: evaluator.id } : {}),
  };
}
export function encodeBankDraft(draft: BankDraft): string {
  return JSON.stringify({ version: 1, draft: draftSchema.parse(draft) });
}
export function decodeBankDraft(value: string | null): BankDraft | undefined {
  if (!value) return undefined;
  try {
    return z
      .object({ version: z.literal(1), draft: draftSchema })
      .parse(JSON.parse(value)).draft;
  } catch {
    return undefined;
  }
}
export function saveDraftQuestion(
  draft: BankDraft,
  previousId: string | undefined,
  question: Question,
  settings: EvaluatorSettings,
): BankDraft {
  questionSchema.parse(question);
  if (
    draft.questions.some(
      (item) => item.id === question.id && item.id !== previousId,
    )
  )
    throw new Error(`Question ID ${question.id} already exists.`);
  const questionOverrides = { ...settings.questionOverrides };
  let calibrationExamples = settings.calibrationExamples;
  if (previousId && previousId !== question.id) {
    if (questionOverrides[previousId])
      questionOverrides[question.id] = questionOverrides[previousId]!;
    delete questionOverrides[previousId];
    calibrationExamples = calibrationExamples?.map((item) =>
      item.questionId === previousId
        ? { ...item, questionId: question.id }
        : item,
    );
  }
  return {
    ...draft,
    questions: previousId
      ? draft.questions.map((item) =>
          item.id === previousId ? question : item,
        )
      : [...draft.questions, question],
    settings: {
      ...settings,
      questionOverrides,
      ...(calibrationExamples ? { calibrationExamples } : {}),
    },
  };
}
export function removeDraftQuestion(
  draft: BankDraft,
  questionId: string,
): BankDraft {
  const questionOverrides = { ...draft.settings.questionOverrides };
  delete questionOverrides[questionId];
  return {
    ...draft,
    questions: draft.questions.filter((item) => item.id !== questionId),
    settings: {
      ...draft.settings,
      questionOverrides,
      ...(draft.settings.calibrationExamples
        ? {
            calibrationExamples: draft.settings.calibrationExamples.filter(
              (item) => item.questionId !== questionId,
            ),
          }
        : {}),
    },
  };
}
