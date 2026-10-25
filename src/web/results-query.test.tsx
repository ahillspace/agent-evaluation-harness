// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RunSummary, WorkspaceView } from "../contracts.js";
import { Results } from "./results.js";

let root: Root, container: HTMLDivElement;
const request = vi.fn();
const run: RunSummary = {
  id: "run",
  name: "Saved run",
  createdAt: "2026-10-10",
  status: "completed",
  bankId: "bank",
  bankName: "Bank",
  targetKind: "managed",
  model: "model",
  harness: "codex",
  completed: 1,
  failed: 0,
  total: 1,
  graded: 1,
  accuracy: 1,
  assessmentPasses: [],
};
const workspace: WorkspaceView = {
  banks: [],
  runs: [run],
  totalRuns: 201,
  blueprints: [],
  researchSessions: [],
  connections: [],
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  request.mockReset();
  request.mockImplementation(async (_url: string, options: RequestInit) => {
    const input = JSON.parse(options.body as string);
    return Response.json({
      runs:
        input.search === "missing"
          ? []
          : [
              {
                ...run,
                name: input.search ? "Source match" : `Page ${input.offset}`,
              },
            ],
      total:
        input.search === "missing" ? 0 : input.search || input.status ? 1 : 201,
      nextOffset: input.search || input.status ? null : input.offset + 100,
    });
  });
  vi.stubGlobal("fetch", request);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const input = async (value: string) =>
  act(async () => {
    const element = container.querySelector<HTMLInputElement>(
      '[aria-label="Search runs"]',
    )!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
it("searches the source and resets pagination while displaying matching counts", async () => {
  await act(async () =>
    root.render(<Results workspace={workspace} refresh={() => {}} />),
  );
  await act(async () =>
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Next")!
      .click(),
  );
  expect(JSON.parse(request.mock.calls.at(-1)![1].body).offset).toBe(100);
  await input("old bank");
  expect(JSON.parse(request.mock.calls.at(-1)![1].body)).toMatchObject({
    search: "old bank",
    offset: 0,
  });
  expect(container.textContent).toContain("Source match");
  expect(container.textContent).toContain("1-1 of 1 matching runs");
  await input("missing");
  expect(container.textContent).toContain("No runs match these filters.");
  expect(container.textContent).toContain("0-0 of 0 matching runs");
});
it("sends the selected status to the same paginated source", async () => {
  await act(async () =>
    root.render(<Results workspace={workspace} refresh={() => {}} />),
  );
  await act(async () => {
    const element = container.querySelector<HTMLSelectElement>(
      '[aria-label="Filter run status"]',
    )!;
    element.value = "failed";
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(JSON.parse(request.mock.calls.at(-1)![1].body)).toMatchObject({
    status: "failed",
    offset: 0,
  });
});
