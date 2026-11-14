// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageValue, RunPerformanceSummary } from "./run-performance.js";
import type { RunPerformance } from "../contracts/assessment-passes.js";

const usage = {
  inputTokens: 1000,
  uncachedInputTokens: 200,
  outputTokens: 50,
  cachedInputTokens: 800,
  costUsd: null,
};
const performance: RunPerformance = {
  durationMs: 1000,
  answerLatencyMs: { average: 500, minimum: 500, maximum: 500 },
  attempts: 1,
  retries: 0,
  answered: 1,
  failures: 0,
  target: { ...usage, turns: 1, toolCalls: 0 },
  researcher: { ...usage, turns: 1 },
  judge: { ...usage, calls: 1 },
};

it("uses separate uncached input, output, and cache values in the performance summary", () => {
  const html = renderToStaticMarkup(
    <RunPerformanceSummary performance={performance} />,
  );
  expect(html).toContain("Input tokens");
  expect(html).toContain("Output tokens");
  expect(html).toContain("Cache tokens");
  expect(html).toContain('title="200"');
  expect(html).toContain('title="800"');
  expect(html).not.toContain('title="1,000"');
});

it("does not label an inclusive legacy input total as uncached input", () => {
  const html = renderToStaticMarkup(
    <RunPerformanceSummary
      performance={{
        ...performance,
        target: { ...performance.target, uncachedInputTokens: undefined },
      }}
    />,
  );
  expect(html).not.toContain('title="1,000"');
  expect(html).toContain("Unknown");
});

it("keeps a reported subtotal visible while another call is pending", () => {
  const html = renderToStaticMarkup(
    <UsageValue
      value={1234567}
      reporting={{ reported: 22, missing: 0, pending: 1 }}
    />,
  );
  expect(html).toContain("1.23M");
  expect(html).toContain('title="1,234,567"');
  expect(html).toContain("22 reported");
  expect(html).toContain("1 pending");
  expect(html).not.toContain("Unknown");
});

it("distinguishes unreported settled calls, pending calls, and no calls", () => {
  expect(
    renderToStaticMarkup(
      <UsageValue
        value={null}
        reporting={{ reported: 0, missing: 0, pending: 1 }}
      />,
    ),
  ).toContain("Pending");
  expect(
    renderToStaticMarkup(
      <UsageValue
        value={null}
        reporting={{ reported: 0, missing: 2, pending: 0 }}
      />,
    ),
  ).toContain("Not reported");
  const partial = renderToStaticMarkup(
    <UsageValue
      value={900}
      reporting={{ reported: 1, missing: 1, pending: 0 }}
    />,
  );
  expect(partial).toContain("900");
  expect(partial).toContain("1 not reported");
  expect(
    renderToStaticMarkup(
      <UsageValue
        value={0}
        reporting={{ reported: 0, missing: 0, pending: 0 }}
      />,
    ),
  ).toContain(">0<");
});

function summary(value?: RunPerformance) {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <RunPerformanceSummary performance={value} />,
  );
  return container;
}

const noUsage = {
  inputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  costUsd: 0,
};

it.each([
  { researcher: 0, judge: 0, labels: ["Target agent"] },
  {
    researcher: 1,
    judge: 0,
    labels: ["Target agent", "Researcher (this run)"],
  },
  { researcher: 0, judge: 1, labels: ["Target agent", "Judges"] },
  {
    researcher: 1,
    judge: 1,
    labels: ["Target agent", "Researcher (this run)", "Judges"],
  },
])(
  "shows roles with activity: researcher=$researcher, judge=$judge",
  ({ researcher, judge, labels }) => {
    const container = summary({
      ...performance,
      researcher: { ...noUsage, turns: researcher },
      judge: { ...noUsage, calls: judge },
    });
    expect(
      Array.from(container.querySelectorAll("tbody tr th")).map(
        (cell) => cell.textContent,
      ),
    ).toEqual(labels);
    expect(
      Array.from(container.querySelector("tbody")!.childNodes).every(
        (node) => node.nodeName === "TR",
      ),
    ).toBe(true);
  },
);

it("keeps optional rows when performance or admission counts are unavailable", () => {
  expect(summary().querySelectorAll("tbody tr")).toHaveLength(3);
  for (const count of [null, undefined]) {
    const value = structuredClone(performance);
    Reflect.set(value.researcher, "turns", count);
    Reflect.set(value.judge, "calls", count);
    const container = summary(value);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(
      container.querySelector("tbody tr:nth-child(2) td:nth-child(5)")
        ?.textContent,
    ).toBe("Unknown");
    expect(
      container.querySelector("tbody tr:nth-child(3) td:nth-child(5)")
        ?.textContent,
    ).toBe("Unknown");
  }
});

it("preserves interrupted researcher subtotals and missing or pending judge coverage", () => {
  const reporting = { reported: 1, missing: 1, pending: 1 };
  const rowUsage = {
    ...usage,
    reporting: {
      inputTokens: reporting,
      uncachedInputTokens: reporting,
      outputTokens: reporting,
      cachedInputTokens: reporting,
      costUsd: reporting,
    },
  };
  const container = summary({
    ...performance,
    researcher: { ...rowUsage, turns: null },
    judge: { ...rowUsage, calls: 3, outputTokens: null },
  });
  const rows = container.querySelectorAll("tbody tr");
  expect(rows).toHaveLength(3);
  expect(rows[1]!.querySelector('[title="200"]')).not.toBeNull();
  expect(rows[1]!.textContent).toContain("1 reported");
  expect(rows[1]!.textContent).toContain("1 not reported");
  expect(rows[1]!.textContent).toContain("1 pending");
  expect(rows[1]!.textContent).toContain("Unknown");
  expect(rows[2]!.textContent).toContain("Not reported");
  expect(rows[2]!.textContent).toContain("1 pending");
});

it("opens the retained attribution and cache explanations from performance help", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<RunPerformanceSummary performance={performance} />),
    );
    expect(container.querySelectorAll(".panel-body > p")).toHaveLength(0);
    const help = container.querySelector<HTMLButtonElement>(
      '[aria-label="About Run performance"]',
    )!;
    expect(help.getAttribute("aria-haspopup")).toBe("dialog");
    await act(async () => help.click());
    const dialog = document.querySelector<HTMLDialogElement>("dialog")!;
    expect(dialog.open).toBe(true);
    const explanation = dialog.textContent!.replace(/\s+/g, " ");
    expect(explanation).toContain(
      "Researcher usage counts decisions made after this run",
    );
    expect(explanation).toContain("cumulative cache counts");
    expect(explanation).toContain("Missing cache reports");
    await act(async () =>
      dialog
        .querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!
        .click(),
    );
    expect(document.querySelector("dialog")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
