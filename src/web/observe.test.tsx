import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Observe, matchesQuestionFilter } from "./observe.js";

vi.mock("./api.js", () => ({
  command: vi.fn(),
  useResource: () => ({ data: null, error: null, refresh: () => {} }),
}));
vi.mock("./observation-stream.js", () => ({
  mergeEvents: (left: unknown[], right: unknown[]) => [...left, ...right],
  useObservation: () => ({
    data: {
      run: {
        id: "run-1",
        name: "Saved evaluation",
        status: "running",
        createdAt: "2026-10-04T12:00:00Z",
        manifest: {
          bank: { bankId: "bank", name: "Retail", number: 1 },
          target: {
            kind: "external",
            adapterId: "generic-http",
            name: "Remote analytics",
            endpoint: "https://example.test/answer",
          },
          repetitions: 1,
          questions: [{ id: "q1", text: "Total revenue?", expected: 120 }],
          evaluator: {
            id: "eval",
            number: 1,
            name: "Exact",
            settings: { mode: "exact" },
          },
          judge: { enabled: false },
        },
      },
      results: [
        { id: "result", questionId: "q1", repetition: 1, status: "queued" },
      ],
      attempts: [],
      events: [],
      reviews: [],
      allowedActions: ["pause", "halt", "cancel"],
      progress: { completed: 0, total: 1, failed: 0 },
      cursor: 0,
    },
    error: null,
    refresh: () => {},
  }),
}));

it("opens Questions first with run totals and Summary second", () => {
  const html = renderToStaticMarkup(
    <Observe runId="run-1" refreshWorkspace={() => {}} />,
  );
  expect(html.match(/>Pause</g)).toHaveLength(1);
  expect(html).not.toContain("Overview");
  expect(html.indexOf(">Questions</button>")).toBeLessThan(
    html.indexOf(">Summary</button>"),
  );
  expect(html).toContain("Questions");
  expect(html).toContain("Configuration");
  expect(html).toContain('role="tabpanel"');
  expect(html).toContain("Score saved answers");
  expect(html).toContain("Review judgments");
  expect(html).toContain("without running the agent again");
  expect(html).toContain('aria-label="Filter questions"');
  expect(html).toContain("0 / 1 answered");
  expect(html).toContain("Run duration");
  expect(html).toContain("Awaiting results");
  expect(html).not.toContain("Evaluation workspace");
});

it("filters question identifiers and text without hiding execution failures", () => {
  expect(
    matchesQuestionFilter(
      "Revenue by country",
      "Q-14",
      "failed",
      "COUNTRY",
      true,
    ),
  ).toBe(true);
  expect(
    matchesQuestionFilter(
      "Revenue by country",
      "Q-14",
      "correct",
      "q-14",
      false,
    ),
  ).toBe(true);
  expect(
    matchesQuestionFilter("Revenue by country", "Q-14", "correct", "", true),
  ).toBe(false);
  expect(
    matchesQuestionFilter("Revenue by country", "Q-14", "queued", "", true),
  ).toBe(false);
  for (const status of [
    "incorrect",
    "error",
    "unscorable",
    "unavailable",
    "interrupted",
  ])
    expect(matchesQuestionFilter("Question", "q", status, "", true)).toBe(true);
});

it("opens linked question evidence directly from a finding", () => {
  const html = renderToStaticMarkup(
    <Observe
      runId="run-1"
      initialResultId="result"
      refreshWorkspace={() => {}}
    />,
  );
  expect(html).toContain('aria-label="Filter questions"');
  expect(html).toContain("Total revenue?");
  expect(html).toContain("Report finding");
  expect(html).toContain("Expected answer and comparison rules");
});
