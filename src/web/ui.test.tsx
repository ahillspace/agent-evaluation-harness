import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Help, Metric, Status, ControlButtons } from "./ui.js";

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
