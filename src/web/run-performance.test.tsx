import { expect, it } from "vitest";
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
