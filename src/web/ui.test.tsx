import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Help,
  Metric,
  Status,
  ControlButtons,
  Tabs,
  tabIndexForKey,
} from "./ui.js";

describe("shared tabs", () => {
  it("wraps arrow keys and supports Home and End without capturing other keys", () => {
    expect(tabIndexForKey("ArrowRight", 2, 3)).toBe(0);
    expect(tabIndexForKey("ArrowLeft", 0, 3)).toBe(2);
    expect(tabIndexForKey("Home", 2, 3)).toBe(0);
    expect(tabIndexForKey("End", 0, 3)).toBe(2);
    expect(tabIndexForKey("Tab", 0, 3)).toBeUndefined();
    expect(tabIndexForKey("ArrowRight", 0, 0)).toBeUndefined();
  });
  it("provides one tab stop and associates the active tab with its panel", () => {
    const html = renderToStaticMarkup(
      <Tabs
        label="Sections"
        value="answer"
        onChange={() => {}}
        items={[
          { value: "activity", label: "Activity" },
          { value: "answer", label: "Answer" },
        ]}
      >
        <p>Recorded answer</p>
      </Tabs>,
    );
    expect(html).toContain('role="tablist" aria-label="Sections"');
    const tabs = [...html.matchAll(/<button[^>]+>/g)].map((match) => match[0]);
    expect(tabs[0]).toContain('tabindex="-1"');
    expect(tabs[1]).toContain('tabindex="0"');
    expect(tabs[1]).toContain('aria-selected="true"');
    const activeId = /id="([^"]+)"/.exec(tabs[1]!)![1];
    const panelId = /aria-controls="([^"]+)"/.exec(tabs[1]!)![1];
    expect(html).toContain(
      `id="${panelId}" role="tabpanel" aria-labelledby="${activeId}"`,
    );
    expect(html).toContain("Recorded answer");
  });
});

describe("honest and accessible presentation", () => {
  it("shows unavailable telemetry without inventing zero values", () => {
    const html = renderToStaticMarkup(<Metric label="Tokens" value={null} />);
    expect(html).toContain("Not recorded");
    expect(html).not.toContain(">0<");
  });
  it("provides keyboard and pointer access to setting explanations", () => {
    const html = renderToStaticMarkup(
      <Help label="Repetitions">Repeat every selected question.</Help>,
    );
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-label="About Repetitions"');
    expect(html).toContain("Repeat every selected question.");
    expect(html).toContain('role="tooltip"');
  });
  it("renders only the actions supplied by the application", () => {
    const html = renderToStaticMarkup(
      <ControlButtons
        actions={["pause", "halt", "cancel"]}
        onAction={() => {}}
        pending="halt"
      />,
    );
    expect(html).toContain("Halt requested");
    expect(html).not.toContain(">Resume</button>");
    expect(html).toContain("disabled");
  });
  it("does not infer confirmed status from a pending control", () => {
    expect(renderToStaticMarkup(<Status value="halting" />)).toContain(
      "Halting",
    );
  });
});
