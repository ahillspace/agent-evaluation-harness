// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  evaluatorSettingsSchema,
  type BankDetail,
  type WorkspaceView,
} from "../contracts.js";
import { Banks } from "./banks.js";

it("refreshes bank detail after another tab publishes while preserving local draft edits", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.clear();
  const revision = {
    id: "v1",
    bankId: "b1",
    name: "Sales",
    number: 1,
    createdAt: "2026-10-22",
    digest: "v1",
    questions: [{ id: "q1", text: "Count?", expected: 1, tags: [] }],
  };
  const evaluator = {
    id: "e1",
    bankId: "b1",
    name: "Rules",
    number: 1,
    createdAt: "2026-10-22",
    digest: "e1",
    settings: evaluatorSettingsSchema.parse({}),
  };
  let detail: BankDetail = {
    bank: {
      id: "b1",
      name: "Sales",
      createdAt: "2026-10-22",
      latestRevisionId: "v1",
      activeEvaluatorRevisionId: "e1",
    },
    revisions: [revision],
    evaluatorRevisions: [evaluator],
    evaluatorDrafts: [],
    jevProfiles: [],
  };
  const fetcher = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => (url.endsWith("banks.get") ? detail : []),
  }));
  vi.stubGlobal("fetch", fetcher);
  const workspace = (): WorkspaceView => ({
    workspaceId: "workspace",
    banks: [
      {
        ...detail.bank,
        questionCount: 1,
        latestRevisionNumber: detail.revisions.at(-1)!.number,
      },
    ],
    runs: [],
    totalRuns: 0,
    blueprints: [],
    researchSessions: [],
    connections: [],
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<Banks workspace={workspace()} refresh={() => {}} />),
    );
    const field = container.querySelector<HTMLInputElement>(
      '[aria-label="Bank name"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(field, "Local unsaved name");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const previousReads = fetcher.mock.calls.filter(([url]) =>
      url.endsWith("banks.get"),
    ).length;
    detail = {
      ...detail,
      bank: {
        ...detail.bank,
        latestRevisionId: "v2",
        activeEvaluatorRevisionId: "e2",
      },
      revisions: [revision, { ...revision, id: "v2", number: 2 }],
      evaluatorRevisions: [evaluator, { ...evaluator, id: "e2", number: 2 }],
    };
    await act(async () =>
      root.render(<Banks workspace={workspace()} refresh={() => {}} />),
    );
    expect(
      fetcher.mock.calls.filter(([url]) => url.endsWith("banks.get")).length,
    ).toBeGreaterThan(previousReads);
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="Bank name"]')
        ?.value,
    ).toBe("Local unsaved name");
    expect(container.textContent).toContain("changed after this draft started");
    expect(
      Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Publish changes",
      )?.disabled,
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  }
});
