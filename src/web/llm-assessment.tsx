import type { AssessmentSummary } from "../contracts.js";
import { ErrorNotice } from "./ui.js";

interface LlmSelection {
  assessment: AssessmentSummary;
  source: "original" | "selected";
  fallback: boolean;
}

export function selectLlmAssessment(input: {
  selected?: AssessmentSummary;
  original?: AssessmentSummary;
  resultId?: string;
  attemptId?: string;
  selectedIsOriginal: boolean;
}): LlmSelection | undefined {
  const matches = (assessment?: AssessmentSummary) =>
    assessment?.resultId === input.resultId &&
    assessment?.attemptId === input.attemptId &&
    (assessment?.judge !== undefined || assessment?.judgeError !== undefined);
  if (input.selected && matches(input.selected)) {
    return {
      assessment: input.selected,
      source: input.selectedIsOriginal ? "original" : "selected",
      fallback: false,
    };
  }
  if (input.original && matches(input.original)) {
    return {
      assessment: input.original,
      source: "original",
      fallback: !input.selectedIsOriginal,
    };
  }
  return undefined;
}

export function LlmAssessment({
  selection,
  enabled,
}: {
  selection?: LlmSelection;
  enabled: boolean;
}) {
  const assessment = selection?.assessment;
  return (
    <>
      <div className="assessment-row">
        <span>LLM judge</span>
        <strong>
          {assessment?.judge
            ? assessment.judge.verdict === null
              ? "No verdict"
              : assessment.judge.verdict
                ? "Pass"
                : "Fail"
            : assessment?.judgeError !== undefined
              ? "Error"
              : enabled
                ? "Not recorded"
                : "Disabled"}
        </strong>
      </div>
      {selection?.source === "original" && (
        <p className="subtle">
          Original run judge
          {selection.fallback
            ? ". Recorded with the original run; not rerun for this rescore."
            : "."}
        </p>
      )}
      {assessment?.judge?.explanation && (
        <p className="subtle">{assessment.judge.explanation}</p>
      )}
      {assessment?.judgeError && <ErrorNotice error={assessment.judgeError} />}
    </>
  );
}
