import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppShell } from "./app-shell.js";

describe("workspace navigation", () => {
  it("provides one labeled destination per section and marks the current page", () => {
    const html = renderToStaticMarkup(
      <AppShell section="/settings" connected>
        <p>Settings content</p>
      </AppShell>,
    );
    for (const destination of ["banks", "runs", "settings"])
      expect(
        html.match(new RegExp(`href="#/${destination}"`, "g")),
      ).toHaveLength(1);
    expect(html).toContain('aria-label="Settings" aria-current="page"');
    expect(html).toContain('href="#main-content"');
    expect(html).not.toContain('href="#/run"');
    expect(html).not.toContain('href="#/results"');
  });
  it("links run details back to Runs and does not advertise an unverified connection", () => {
    const html = renderToStaticMarkup(
      <AppShell section="/runs" location="Run details" connected={false}>
        <p>Run content</p>
      </AppShell>,
    );
    expect(html).toContain('<a href="#/runs">Runs</a>');
    expect(html).toContain("Run details");
    expect(html).toContain("Engine unavailable");
    expect(html).not.toContain("Engine connected");
  });
});
