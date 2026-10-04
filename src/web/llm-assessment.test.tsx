import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssessmentSummary } from "../contracts.js";
import { LlmAssessment, selectLlmAssessment } from "./llm-assessment.js";

const original: AssessmentSummary = {
  resultId: "result-1",
  attemptId: "attempt-1",
  deterministic: { status: "incorrect", explanation: "Original criteria" },
  judge: { verdict: true, explanation: "The recorded answer is correct." },
};
const rescore: AssessmentSummary = {
  resultId: "result-1",
  attemptId: "attempt-1",
  deterministic: { status: "correct", explanation: "Revised criteria" },
};
const input = {
  resultId: "result-1",
  attemptId: "attempt-1",
  selectedIsOriginal: false,
  selected: rescore,
  original,
};

describe("independent LLM judge presentation", () => {
  it("shows an abstaining judge as no verdict rather than a failure", () => {
    const selection = selectLlmAssessment({
      ...input,
      selected: {
        ...rescore,
        judge: { verdict: null, explanation: "Reference needs review" },
      },
    });
    const html = renderToStaticMarkup(
      <LlmAssessment selection={selection} enabled />,
    );
    expect(html).toContain("No verdict");
    expect(html).not.toContain(">Fail<");
  });
  it("preserves the original judge when a deterministic rescore has no judge", () => {
    const selection = selectLlmAssessment(input);
    expect(selection?.assessment).toBe(original);
    const html = renderToStaticMarkup(
      <LlmAssessment selection={selection} enabled />,
    );
    expect(html).toContain("Pass");
    expect(html).toContain("Original run judge");
    expect(html).toContain("not rerun for this rescore");
    expect(html).toContain(original.judge!.explanation);
    expect(rescore.judge).toBeUndefined();
  });
  it("prefers the selected assessment's judge when one was recorded", () => {
    const selected = { ...rescore, judge: { verdict: false } };
    const selection = selectLlmAssessment({ ...input, selected });
    expect(selection?.assessment).toBe(selected);
    expect(selection?.source).toBe("selected");
  });
  it("retains original judge errors without inventing a verdict", () => {
    const selection = selectLlmAssessment({
      ...input,
      original: { ...rescore, judgeError: "Provider unavailable" },
    });
    const html = renderToStaticMarkup(
      <LlmAssessment selection={selection} enabled />,
    );
    expect(html).toContain("Error");
    expect(html).toContain("Provider unavailable");
    expect(html).toContain("Original run judge");
  });
  it("never borrows a judge from a different result or attempt", () => {
    for (const mismatch of [{ resultId: "other" }, { attemptId: "other" }]) {
      expect(
        selectLlmAssessment({
          ...input,
          original: { ...original, ...mismatch },
        }),
      ).toBeUndefined();
      expect(
        selectLlmAssessment({
          ...input,
          selected: { ...original, ...mismatch },
          original: undefined,
        }),
      ).toBeUndefined();
    }
  });
  it("identifies original provenance without calling the original a rescore", () => {
    const selection = selectLlmAssessment({
      ...input,
      selected: original,
      selectedIsOriginal: true,
    });
    const html = renderToStaticMarkup(
      <LlmAssessment selection={selection} enabled />,
    );
    expect(html).toContain("Original run judge");
    expect(html).not.toContain("not rerun for this rescore");
  });
  it("distinguishes absent recordings from disabled judging", () => {
    expect(renderToStaticMarkup(<LlmAssessment enabled />)).toContain(
      "Not recorded",
    );
    expect(renderToStaticMarkup(<LlmAssessment enabled={false} />)).toContain(
      "Disabled",
    );
  });
});
