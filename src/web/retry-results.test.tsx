// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RunView } from "../contracts.js";
import { RetryResults } from "./retry-results.js";

const { command, navigate } = vi.hoisted(() => ({
  command: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("./api.js", () => ({ command, navigate }));
let root: Root;
let container: HTMLDivElement;
const refresh = vi.fn();
const view = (available = true) =>
  ({
    run: { id: "retry", retryOf: { runId: "original", resultIds: ["r1"] } },
    retryApplyEligibility: {
      available,
      originalRunId: "original",
      resultIds: ["r1"],
      alreadyAppliedResultIds: [],
      reason: available ? undefined : "Wait for judging to finish.",
    },
    retryApplications: [],
    retryRuns: [],
  }) as unknown as RunView;
const button = (label: string) => {
  const found = Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  command.mockReset();
  navigate.mockReset();
  refresh.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("uses engine eligibility and explains why applying is unavailable", async () => {
  await act(async () =>
    root.render(<RetryResults view={view(false)} onSaved={refresh} />),
  );
  expect(button("Apply rerun results").disabled).toBe(true);
  expect(container.textContent).toContain("Wait for judging to finish.");
});
it("applies completed rerun answers without launching or judging again", async () => {
  command.mockResolvedValue({
    applicationId: "a1",
    appliedResultIds: ["r1"],
    assessmentPassIds: ["new-score"],
    alreadyApplied: false,
  });
  await act(async () =>
    root.render(<RetryResults view={view()} onSaved={refresh} />),
  );
  await act(async () => button("Apply rerun results").click());
  expect(document.body.textContent).toContain(
    "Original attempts and scores stay available.",
  );
  await act(async () => button("Apply 1 answer").click());
  expect(command).toHaveBeenCalledWith(
    "runs.apply-retry",
    expect.objectContaining({
      runId: "original",
      retryRunId: "retry",
      idempotencyKey: expect.any(String),
    }),
  );
  expect(command).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledOnce();
  expect(navigate).toHaveBeenCalledWith("/observe/original");
});
it("does not navigate or refresh an abandoned page after applying finishes", async () => {
  let finish!: (value: unknown) => void;
  command.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  await act(async () =>
    root.render(<RetryResults view={view()} onSaved={refresh} />),
  );
  await act(async () => button("Apply rerun results").click());
  await act(async () => button("Apply 1 answer").click());
  await act(async () => root.render(<div>Another page</div>));
  await act(async () => finish({ appliedResultIds: ["r1"] }));
  expect(command).toHaveBeenCalledOnce();
  expect(refresh).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
  expect(container.textContent).toBe("Another page");
});
it("offers a linked rerun from its original run", async () => {
  const original = {
    ...view(),
    run: { id: "original" },
    retryApplyEligibility: undefined,
    retryRuns: [
      {
        runId: "retry",
        name: "One-question rerun",
        available: true,
        resultIds: ["r1"],
        alreadyAppliedResultIds: [],
      },
    ],
  } as unknown as RunView;
  await act(async () =>
    root.render(<RetryResults view={original} onSaved={refresh} />),
  );
  expect(container.textContent).toContain("One-question rerun");
  await act(async () => button("Apply rerun results").click());
  expect(document.body.textContent).toContain("Apply 1 answer");
});
it("keeps apply errors visible and reuses the request key when retried", async () => {
  command.mockRejectedValue(
    new Error("The run changed. Refresh and try again."),
  );
  await act(async () =>
    root.render(<RetryResults view={view()} onSaved={refresh} />),
  );
  await act(async () => button("Apply rerun results").click());
  await act(async () => button("Apply 1 answer").click());
  expect(document.body.textContent).toContain("The run changed.");
  await act(async () => button("Apply 1 answer").click());
  expect(command.mock.calls[0]?.[1].idempotencyKey).toBe(
    command.mock.calls[1]?.[1].idempotencyKey,
  );
  expect(navigate).not.toHaveBeenCalled();
});
it("counts only new answers and requires confirmation before replacing an earlier rerun", async () => {
  const replacement = view();
  replacement.retryApplyEligibility!.resultIds = ["r1", "r2"];
  replacement.retryApplyEligibility!.alreadyAppliedResultIds = ["r1"];
  replacement.retryApplyEligibility!.replacementResultIds = ["r2"];
  command.mockResolvedValue({ appliedResultIds: ["r2"] });
  await act(async () =>
    root.render(<RetryResults view={replacement} onSaved={refresh} />),
  );
  await act(async () => button("Apply rerun results").click());
  expect(button("Apply 1 answer").disabled).toBe(true);
  const checkbox = document.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  )!;
  await act(async () => checkbox.click());
  expect(button("Apply 1 answer").disabled).toBe(false);
  await act(async () => button("Apply 1 answer").click());
  expect(command).toHaveBeenCalledWith(
    "runs.apply-retry",
    expect.objectContaining({
      resultIds: ["r2"],
      replaceApplied: true,
    }),
  );
});
