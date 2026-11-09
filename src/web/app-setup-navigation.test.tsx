// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { App } from "./app.js";
import { createLaunch, initialSetup } from "./drafts.js";
import {
  decodeSetupDraft,
  encodeSetupDraft,
  setupDraftKey,
} from "./setup-draft.js";
import type { WorkspaceView } from "../contracts.js";

it("keeps a pending launch and tab-local draft through aliases, library navigation, and reload", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.clear();
  const workspace: WorkspaceView = {
    workspaceId: "navigation-workspace",
    banks: [],
    runs: [],
    totalRuns: 0,
    blueprints: [],
    connections: [],
    researchSessions: [],
    runtime: { harnesses: [], connectionProviders: [], maxConcurrency: 1 },
  };
  const draft = {
    ...initialSetup(),
    model: "fixture-model",
    bankRevisionId: "revision",
  };
  const pendingLaunch = JSON.parse(
    JSON.stringify({
      operation: "runs.launch" as const,
      input: {
        ...createLaunch(draft),
        idempotencyKey: "pending-navigation-launch",
      },
    }),
  );
  const key = setupDraftKey(workspace.workspaceId)!;
  const saved = encodeSetupDraft(
    draft,
    "research",
    "run:source",
    pendingLaunch,
  );
  sessionStorage.setItem(key, saved);
  const request = vi.fn(async (url: string) => {
    if (url.endsWith("workspace.get")) return Response.json(workspace);
    if (url.endsWith("runtime.discover"))
      return Response.json(workspace.runtime);
    if (url.endsWith("runs.list"))
      return Response.json({ runs: [], total: 0, nextOffset: null });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", request);
  const container = document.createElement("div");
  document.body.append(container);
  let root = createRoot(container);
  const navigate = async (path: string, render = false) =>
    act(async () => {
      window.history.replaceState(null, "", `#${path}`);
      if (render) root.render(<App />);
      else window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
  try {
    await navigate("/run?source=source", true);
    await navigate("/runs/new?source=source");
    expect(decodeSetupDraft(sessionStorage.getItem(key))).toMatchObject({
      draft: { model: "fixture-model" },
      section: "research",
      source: "run:source",
      pendingLaunch,
    });
    await navigate("/runs");
    expect(container.querySelector("h1")?.textContent).toBe("Runs");
    await navigate("/runs/new?source=source");
    await act(async () => root.unmount());
    root = createRoot(container);
    await navigate("/run?source=source", true);
    expect(
      decodeSetupDraft(sessionStorage.getItem(key))?.pendingLaunch,
    ).toEqual(pendingLaunch);
    expect(decodeSetupDraft(sessionStorage.getItem(key))?.section).toBe(
      "research",
    );
    expect(
      request.mock.calls.every(
        ([url]) =>
          url.endsWith("workspace.get") ||
          url.endsWith("runs.list") ||
          url.endsWith("runtime.discover"),
      ),
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  }
});
