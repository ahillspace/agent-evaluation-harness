import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssessmentPassSummary } from "../contracts/assessment-passes.js";
import {
  AssessmentScore,
  AssessmentSelector,
  AssessmentScores,
} from "./assessment-controls.js";
import { RunPerformanceSummary } from "./run-performance.js";

vi.mock("./api.js", () => ({ command: vi.fn() }));

const pass: AssessmentPassSummary = {
  id: "pass",
  runId: "run",
  name: "Reviewed answers",
  source: "human",
  status: "completed",
  createdAt: "2026-10-05T12:00:00Z",
  basis: {
    bankRevisionId: "bank",
    evaluatorRevisionId: "eval",
    referenceHash: "hash",
  },
  coverage: {
    eligible: 10,
    answered: 8,
    judged: 6,
    correct: 4,
    incorrect: 2,
    unjudged: 2,
    errors: 2,
    excluded: 1,
    reviewed: 1,
    overridden: 1,
  },
  accuracy: 4 / 6,
  judgedAccuracy: 4 / 6,
};

it("uses completed judgments for accuracy and separates coverage", () => {
  const html = renderToStaticMarkup(<AssessmentScore pass={pass} />);
  expect(html).toContain("66.7%");
  expect(html).toContain("4 / 6 correct");
  expect(html).toContain("6 / 10 judged");
  expect(html).toContain("2 unjudged");
  expect(html).toContain("2 assessment errors");
  expect(html).toContain("1 excluded");
});

it("reads judged accuracy from an already running server with older outcome semantics", () => {
  const html = renderToStaticMarkup(
    <AssessmentScore pass={{ ...pass, accuracy: 0.4 }} />,
  );
  expect(html).toContain("66.7%");
  expect(html).not.toContain("40.0%");
});

it("shows every named assessment with no invented zero before judgments", () => {
  const html = renderToStaticMarkup(
    <AssessmentScores
      passes={[
        pass,
        {
          ...pass,
          id: "jev",
          name: "Jev review",
          source: "jev",
          accuracy: null,
          judgedAccuracy: null,
          coverage: { ...pass.coverage, judged: 0, correct: 0, incorrect: 0 },
        },
      ]}
      selectedId={pass.id}
    />,
  );
  expect(html).toContain("Reviewed answers");
  expect(html).toContain("Jev review");
  expect(html).toContain("Awaiting results");
  expect(html).not.toContain("0.0%");
});

it("offers named saved scores without adding score columns", () => {
  const html = renderToStaticMarkup(
    <AssessmentSelector
      runId="run"
      passes={[pass]}
      selectedId="pass"
      onSaved={() => {}}
    />,
  );
  expect(html).toContain('aria-label="Saved score"');
  expect(html).toContain("Reviewed answers");
});

it("shows unknown performance instead of fabricated zero usage", () => {
  const html = renderToStaticMarkup(<RunPerformanceSummary />);
  expect(html).toContain("Unknown");
  expect(html).toContain("Target agent");
  expect(html).toContain("Researcher");
  expect(html).toContain("Judges");
  expect(html).not.toContain(">0<");
});
