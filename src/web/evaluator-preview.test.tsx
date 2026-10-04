import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { EvaluationPreview } from "../contracts.js";
import { EvaluatorPreview } from "./evaluator-preview.js";

describe("evaluator preview presentation", () => {
  it("shows unchanged scores clearly without expanding internal JSON", () => {
    const preview = {
      runs: [
        {
          runId: "r1",
          name: "Revenue check",
          rows: [
            {
              resultId: "x",
              questionId: "q1",
              question: "What was revenue?",
              repetition: 1,
              before: { status: "correct", explanation: "Matches" },
              after: { status: "correct", explanation: "Matches" },
              changed: false,
            },
          ],
          assessments: [],
          changes: [],
        },
      ],
    } as unknown as EvaluationPreview;
    const html = renderToStaticMarkup(<EvaluatorPreview preview={preview} />);
    expect(html).toContain("No score changes");
    expect(html).toContain("What was revenue?");
    expect(html).toContain("Pass");
    expect(html).not.toContain("<details open");
  });
});
