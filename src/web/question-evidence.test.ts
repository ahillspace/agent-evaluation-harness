import { expect, it } from "vitest";
import type { AssessmentPass, RunView } from "../contracts.js";
import { questionEvidence } from "./question-evidence.js";

const view = {
  run: { id: "original" },
  results: [
    {
      id: "r1",
      questionId: "q1",
      status: "failed",
      answerSource: {
        runId: "retry",
        resultId: "rr1",
        attemptId: "retry-attempt",
        evidenceHash: "hash",
      },
    },
  ],
  attempts: [
    {
      id: "original-attempt",
      runId: "original",
      resultId: "r1",
      status: "failed",
    },
    {
      id: "retry-attempt",
      runId: "retry",
      resultId: "rr1",
      status: "completed",
    },
  ],
} as unknown as RunView;
it("uses the applied answer when no historical score is selected", () => {
  const evidence = questionEvidence(view, view.results[0]!);
  expect(evidence.attempt?.id).toBe("retry-attempt");
  expect(evidence.fromRerun).toBe(true);
  expect(evidence.completed).toBe(true);
});
it("preserves the original failed evidence for the original score", () => {
  const pass = {
    judgments: [{ resultId: "r1", status: "unjudged" }],
  } as AssessmentPass;
  const evidence = questionEvidence(view, view.results[0]!, pass);
  expect(evidence.attempt?.id).toBe("original-attempt");
  expect(evidence.completed).toBe(false);
  expect(evidence.fromRerun).toBe(false);
});
it("uses the physical retry attempt identified by the selected score", () => {
  const pass = {
    judgments: [
      {
        resultId: "r1",
        attemptId: "retry-attempt",
        source: { runId: "retry", resultId: "rr1" },
        status: "correct",
      },
    ],
  } as AssessmentPass;
  expect(questionEvidence(view, view.results[0]!, pass).attempt?.id).toBe(
    "retry-attempt",
  );
  expect(
    questionEvidence(view, view.results[0]!, pass, "original-attempt").attempt
      ?.id,
  ).toBe("original-attempt");
});
