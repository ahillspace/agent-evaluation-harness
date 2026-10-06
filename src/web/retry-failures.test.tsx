import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunView } from "../contracts.js";
import { RetryFailures } from "./retry-failures.js";

function view(status: string, available: boolean) {
  return {
    results: [{ id: "r", status }],
    retryEligibility: {
      available,
      resultIds: ["r"],
      requiresAcknowledgment: false,
      reason: "Stop active work first.",
    },
  } as unknown as RunView;
}
it("does not offer retries for completed or incorrectly graded answers", () => {
  expect(
    renderToStaticMarkup(<RetryFailures view={view("completed", true)} />),
  ).toBe("");
});
it("uses application retry eligibility rather than inferring safety from the UI", () => {
  const html = renderToStaticMarkup(
    <RetryFailures view={view("failed", false)} />,
  );
  expect(html).toContain("disabled");
  expect(html).toContain("Stop active work first.");
  expect(html).toContain("Rerun failed questions (1)");
  expect(
    renderToStaticMarkup(<RetryFailures view={view("failed", true)} />),
  ).not.toContain("disabled");
});
