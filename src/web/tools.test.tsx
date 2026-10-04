import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCatalog, toolSummary } from "./tools.js";

describe("tool selection", () => {
  it("limits inline tool descriptions without losing the tool name", () => {
    expect(
      toolSummary("A long description. ".repeat(1000)).length,
    ).toBeLessThanOrEqual(160);
    const html = renderToStaticMarkup(
      <ToolCatalog
        tools={[
          {
            name: "query-datasource",
            description: "Detailed markdown ".repeat(1000),
          },
        ]}
        selected={[]}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Allow query-datasource"');
    expect(html).toContain("Search available tools");
    expect(html).not.toContain("Detailed markdown ".repeat(100));
  });
});
