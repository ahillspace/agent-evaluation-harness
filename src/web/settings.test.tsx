// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Settings } from "./settings.js";
import type { WorkspaceView } from "../contracts.js";

it("keeps the selected Settings tab synchronized with direct and history navigation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        harnesses: [],
        connectionProviders: [],
        maxConcurrency: 1,
      }),
    })),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const workspace = {
    banks: [],
    runs: [],
    totalRuns: 0,
    blueprints: [],
    researchSessions: [],
    connections: [],
  } as WorkspaceView;
  try {
    window.location.hash = "/settings/harnesses";
    await act(async () =>
      root.render(<Settings workspace={workspace} refresh={() => {}} />),
    );
    expect(container.querySelector('[aria-selected="true"]')?.textContent).toBe(
      "Subscriptions & harnesses",
    );
    await act(async () => {
      window.location.hash = "/settings/connections";
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(container.querySelector('[aria-selected="true"]')?.textContent).toBe(
      "Connections",
    );
    expect(container.textContent).toContain("Connect your first data source");
    await act(async () => {
      window.location.hash = "/settings/harnesses";
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(container.querySelector('[aria-selected="true"]')?.textContent).toBe(
      "Subscriptions & harnesses",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
