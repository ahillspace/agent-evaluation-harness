import { describe, expect, it } from "vitest";
import { evaluatorSettingsSchema } from "../contracts.js";
import {
  bankDraftKey,
  bankDraftsEqual,
  decodeBankDraft,
  encodeBankDraft,
  initialBankDraft,
  removeDraftQuestion,
  saveDraftQuestion,
} from "./bank-draft.js";
import { parseBankImport } from "./bank-import.js";

describe("question bank drafts", () => {
  it("compares object content independently of storage key order while preserving array order", () => {
    const draft = initialBankDraft();
    draft.questions = [
      { id: "q1", text: "Count?", tags: [], expected: { a: 1, b: 2 } },
    ];
    const reordered = {
      ...draft,
      settings: Object.fromEntries(
        Object.entries(draft.settings).reverse(),
      ) as typeof draft.settings,
      questions: [{ ...draft.questions[0]!, expected: { b: 2, a: 1 } }],
    };
    expect(bankDraftsEqual(draft, reordered)).toBe(true);
    expect(
      bankDraftsEqual(draft, {
        ...reordered,
        questions: [{ ...draft.questions[0]!, expected: { b: 3, a: 1 } }],
      }),
    ).toBe(false);
    expect(
      bankDraftsEqual(
        { ...draft, questions: [{ ...draft.questions[0]!, expected: [1, 2] }] },
        { ...draft, questions: [{ ...draft.questions[0]!, expected: [2, 1] }] },
      ),
    ).toBe(false);
  });
  it("isolates drafts by workspace and bank", () => {
    expect(bankDraftKey(undefined, "b")).toBeUndefined();
    expect(bankDraftKey("one", "b")).not.toBe(bankDraftKey("two", "b"));
    expect(bankDraftKey("one", "b")).not.toBe(bankDraftKey("one", "c"));
  });
  it("preserves incomplete authoring and publication bases", () => {
    const draft = {
      ...initialBankDraft(),
      baseRevisionId: "r1",
      baseEvaluatorRevisionId: "e1",
      questions: [
        { id: "q1", text: "", expected: "", tags: [], context: "Public" },
      ],
    };
    expect(decodeBankDraft(encodeBankDraft(draft))).toEqual(draft);
    expect(decodeBankDraft('{"version":20}')).toBeUndefined();
  });
  it("persists incomplete comparison policies without imposing publication validation", () => {
    const draft = initialBankDraft();
    draft.settings = {
      ...draft.settings,
      sortOrder: [{ column: "", direction: "asc" }],
      absoluteTolerance: -1,
      decimalPlaces: 13,
      answerPath: "unfinished pointer",
      referenceDisposition: "needs_review",
      referenceNote: "",
      code: "return {",
      questionOverrides: { q1: { relativeTolerance: -1 } },
    };
    expect(decodeBankDraft(encodeBankDraft(draft))).toEqual(draft);
    expect(evaluatorSettingsSchema.safeParse(draft.settings).success).toBe(
      false,
    );
  });
  it("rejects unsupported CSV fields instead of dropping them from imported questions", () => {
    expect(() =>
      parseBankImport(
        'question,expected,context\n"Count?",1,"Use the latest quarter"',
      ),
    ).toThrow("Unsupported CSV columns: context");
  });
  it("rejects unsupported JSON fields in packages, raw arrays, and legacy wrappers", () => {
    const question = {
      id: "q1",
      text: "Count?",
      expected: 1,
      criteria: "Private unsupported criteria",
    };
    expect(() => parseBankImport(JSON.stringify([question]))).toThrow(
      "criteria",
    );
    expect(() =>
      parseBankImport(
        JSON.stringify({
          format: "agent-evaluation-harness/question-bank",
          version: 1,
          name: "Package",
          questions: [question],
          evaluator: { name: "Rules", settings: {} },
        }),
      ),
    ).toThrow("criteria");
    expect(() =>
      parseBankImport(
        JSON.stringify({
          questions: [{ id: "q1", text: "Count?", expected: 1 }],
          criteria: "Unsupported bank criteria",
        }),
      ),
    ).toThrow("criteria");
  });
  it("retains recognized legacy revision questions and bank names", () => {
    const legacy = {
      id: "r1",
      bankId: "b1",
      number: 1,
      name: "Legacy bank",
      createdAt: "2026-10-11",
      digest: "digest",
      questions: [{ id: "q1", text: "Count?", expected: 1 }],
    };
    expect(parseBankImport(JSON.stringify(legacy))).toMatchObject({
      name: "Legacy bank",
      questions: [{ id: "q1", expected: 1 }],
    });
  });
  it("renames question overrides and calibration without changing sibling rules", () => {
    const draft = {
      ...initialBankDraft(),
      questions: [{ id: "q1", text: "Count", expected: 1, tags: [] }],
      settings: evaluatorSettingsSchema.parse({
        questionOverrides: {
          q1: { decimalPlaces: 1 },
          q2: { caseSensitive: true },
        },
        calibrationExamples: [
          {
            id: "case",
            questionId: "q1",
            answer: 1,
            expectedStatus: "correct",
          },
        ],
      }),
    };
    const next = saveDraftQuestion(
      draft,
      "q1",
      { ...draft.questions[0]!, id: "renamed" },
      draft.settings,
    );
    expect(next.settings.questionOverrides).toEqual({
      renamed: { decimalPlaces: 1 },
      q2: { caseSensitive: true },
    });
    expect(next.settings.calibrationExamples?.[0]?.questionId).toBe("renamed");
    expect(() =>
      saveDraftQuestion(next, undefined, next.questions[0]!, next.settings),
    ).toThrow("already exists");
    expect(
      removeDraftQuestion(next, "renamed").settings.questionOverrides,
    ).toEqual({ q2: { caseSensitive: true } });
    expect(
      removeDraftQuestion(next, "renamed").settings.calibrationExamples,
    ).toEqual([]);
  });
  it("preserves complete package settings and exposes imported judge criteria", () => {
    const imported = parseBankImport(
      JSON.stringify({
        format: "agent-evaluation-harness/question-bank",
        version: 1,
        name: "Imported",
        questions: [{ id: "q1", text: "Count", expected: 1 }],
        evaluator: { name: "Precision", settings: { decimalPlaces: 1 } },
        jevProfile: { name: "Review", settings: {} },
      }),
    );
    expect(imported.evaluator?.settings.decimalPlaces).toBe(1);
    expect(imported.jevProfile?.name).toBe("Review");
    expect(() =>
      parseBankImport('{"format":"unknown","version":1,"questions":[]}'),
    ).toThrow();
  });
});
