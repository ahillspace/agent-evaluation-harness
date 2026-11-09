import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssessmentPassSummary } from "../contracts/assessment-passes.js";
import { AssessmentScore, AssessmentSelector } from "./assessment-controls.js";
import { RunPerformanceSummary } from "./run-performance.js";

const { command } = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("./api.js", () => ({ command }));

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
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";

it("distinguishes repeated score names with seconds and selects physical pass IDs", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  command.mockReset().mockResolvedValue({});
  const onSaved = vi.fn();
  const repeated = [
    {
      ...pass,
      id: "first-pass",
      name: "Updated deterministic",
      createdAt: "2026-11-09T12:00:03Z",
    },
    {
      ...pass,
      id: "second-pass",
      name: "Updated deterministic",
      createdAt: "2026-11-09T12:00:06Z",
    },
    { ...pass, id: "unique-pass", name: "Human review" },
  ];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <AssessmentSelector runId="run" passes={repeated} onSaved={onSaved} />,
      ),
    );
    const selector = container.querySelector("select")!;
    const labels = new Map(
      Array.from(selector.options).map((option) => [
        option.value,
        option.textContent,
      ]),
    );
    expect(labels.get("first-pass")).not.toBe(labels.get("second-pass"));
    expect(labels.get("first-pass")).toMatch(/:\d{2}:03/);
    expect(labels.get("second-pass")).toMatch(/:\d{2}:06/);
    expect(labels.get("unique-pass")).toBe("Human review");
    for (const passId of ["second-pass", "first-pass"]) {
      await act(async () => {
        selector.value = passId;
        selector.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(command).toHaveBeenLastCalledWith("runs.select-assessment", {
        runId: "run",
        passId,
      });
      expect(onSaved).toHaveBeenLastCalledWith(passId);
    }
    await act(async () =>
      root.render(
        <AssessmentSelector
          runId="run"
          passes={[...repeated].reverse()}
          onSaved={onSaved}
        />,
      ),
    );
    expect(
      new Map(
        Array.from(selector.options).map((option) => [
          option.value,
          option.textContent,
        ]),
      ),
    ).toEqual(labels);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("keeps same-second duplicate scores distinguishable by their own physical identity", () => {
  const html = renderToStaticMarkup(
    <AssessmentSelector
      runId="run"
      passes={[
        {
          ...pass,
          id: "physical-first",
          createdAt: "2026-11-09T12:00:03.100Z",
        },
        {
          ...pass,
          id: "physical-second",
          createdAt: "2026-11-09T12:00:03.900Z",
        },
      ]}
      onSaved={() => {}}
    />,
  );
  expect(html).toMatch(/>Reviewed answers[^<]*physical-first/);
  expect(html).toMatch(/>Reviewed answers[^<]*physical-second/);
});
