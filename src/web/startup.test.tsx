import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Setup } from "./setup.js";
import { FatalError } from "./error-boundary.js";
import type { WorkspaceView } from "../contracts.js";

describe("initial workspace rendering", () => {
  it("renders setup guidance from a fresh summary-only workspace without runtime discovery", () => {
    const workspace: WorkspaceView = {
      banks: [],
      runs: [],
      totalRuns: 0,
      blueprints: [],
      researchSessions: [],
      connections: [],
    };
    const html = renderToStaticMarkup(
      <Setup workspace={workspace} refresh={() => {}} />,
    );
    expect(html).toContain("Create a question bank first");
    expect(html).toContain("Open question banks");
  });
  it("offers visible recovery when a screen cannot render", () => {
    const html = renderToStaticMarkup(
      <FatalError message="The saved view could not load." />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Reload workspace");
    expect(html).toContain("The saved view could not load.");
  });
});
