import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CalibrationResults } from "./calibration-results.js";
import {
  ReferenceSelector,
  selectedReferenceQuestion,
  ignoredReferencePolicies,
  ReferencePolicyWarning,
} from "./reference-selector.js";
import { EvaluatorPolicy } from "./evaluator-policy.js";
import { evaluatorSettingsSchema } from "../contracts.js";
import type { BankRevision } from "../contracts.js";
import type { ComponentProps } from "react";
import { BankEvaluator } from "./bank-evaluator.js";

it("warns about ignored reference policies without mapping them into evaluator settings", () => {
  const question = {
    id: "q1",
    text: "Count?",
    tags: [],
    expected: {
      type: "table",
      tolerance: 0.5,
      allow_column_permutation: true,
      order_by: ["count"],
    },
  };
  expect(ignoredReferencePolicies([question])).toEqual([
    { questionId: "q1", fields: ["tolerance", "allow_column_permutation"] },
  ]);
  const html = renderToStaticMarkup(
    <ReferencePolicyWarning questions={[question]} />,
  );
  expect(html).toContain("Comparison uses published evaluator settings");
  expect(html).toContain("Move these rules into evaluator settings");
  expect(html).not.toContain("order_by");
  expect(ignoredReferencePolicies([{ ...question, expected: 5 }])).toEqual([]);
});

it("offers calibration without requiring a saved run and keeps advanced rules collapsed", () => {
  const workspace = {
    banks: [{ id: "bank", name: "Example", activeEvaluatorRevisionId: "e" }],
    revisions: [],
    evaluatorRevisions: [],
    evaluatorDrafts: [],
    runs: [],
  } as unknown as ComponentProps<typeof BankEvaluator>["workspace"];
  const html = renderToStaticMarkup(
    <BankEvaluator workspace={workspace} bankId="bank" refresh={() => {}} />,
  );
  expect(html).toContain("Check calibration");
  expect(html).not.toContain(
    '<button class="button secondary" disabled="">Check calibration',
  );
  expect(html).toContain("Publication always checks calibration");
  expect(html).not.toContain("<details open");
});

it("never presents frozen answers as corrected references while data loads", () => {
  const frozen = { id: "q", text: "Count?", expected: 11, tags: [] };
  const input = {
    frozen,
    questionId: "q",
    referenceBankId: "new",
    revisions: [],
  };
  expect(selectedReferenceQuestion(input)).toBeUndefined();
  expect(
    selectedReferenceQuestion({ ...input, referenceBankId: undefined }),
  ).toBe(frozen);
  const corrected = { ...frozen, expected: 26 };
  const revision: BankRevision = {
    id: "new",
    bankId: "bank",
    number: 2,
    createdAt: "2026-10-04",
    name: "Corrected",
    digest: "digest",
    questions: [corrected],
  };
  expect(selectedReferenceQuestion({ ...input, revisions: [revision] })).toBe(
    corrected,
  );
});

it("shows calibration disagreements with expected and actual verdicts", () => {
  const html = renderToStaticMarkup(
    <CalibrationResults
      report={{
        bankRevisionId: "bank1",
        total: 1,
        passed: 0,
        results: [
          {
            id: "rounded",
            questionId: "q1",
            expectedStatus: "correct",
            actual: { status: "incorrect", explanation: "Wrong precision" },
            passed: false,
          },
        ],
      }}
    />,
  );
  expect(html).toContain("0 / 1 calibration cases agree");
  expect(html).toContain("Failed case");
  expect(html).toContain("Wrong precision");
  expect(html).toContain("Expected verdict");
});
it("makes frozen references the default for saved-answer rescoring", () => {
  const html = renderToStaticMarkup(
    <ReferenceSelector revisions={[]} value="" onChange={() => {}} />,
  );
  expect(html).toContain('value="" selected=""');
  expect(html).toContain("Frozen references from each run");
});
it("exposes reference exclusion with its reason and comparison controls", () => {
  const html = renderToStaticMarkup(
    <EvaluatorPolicy
      settings={evaluatorSettingsSchema.parse({
        referenceDisposition: "needs_review",
        referenceNote: "Wrong source scope",
      })}
      onChange={() => {}}
    />,
  );
  expect(html).toContain("Reference review reason");
  expect(html).toContain("Wrong source scope");
  expect(html).toContain("Decimal places");
  expect(html).toContain("Answer extraction path");
});
