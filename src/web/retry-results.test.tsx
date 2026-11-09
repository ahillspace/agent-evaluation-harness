import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunView } from "../contracts.js";
import { RetryResults } from "./retry-results.js";

it("keeps historical linked Runs and answer bindings read-only", () => {
  const view = {
    run: { id: "original" },
    retryRuns: [{ runId: "retry", name: "Historical rerun", available: true }],
    retryApplications: [
      {
        id: "applied",
        retryRunId: "retry",
        bindings: [{ resultId: "result" }],
      },
    ],
  } as unknown as RunView;
  const html = renderToStaticMarkup(<RetryResults view={view} />);
  expect(html).toContain("Historical rerun");
  expect(html).toContain("#/runs/retry");
  expect(html).toContain("1 answer");
  expect(html).not.toContain("<button");
  expect(html).not.toContain("Apply rerun");
});
it("retains the historical original Run link without apply instructions", () => {
  const view = {
    run: { id: "retry", retryOf: { runId: "original" } },
  } as unknown as RunView;
  const html = renderToStaticMarkup(<RetryResults view={view} />);
  expect(html).toContain("#/runs/original");
  expect(html).not.toContain("Apply");
});
