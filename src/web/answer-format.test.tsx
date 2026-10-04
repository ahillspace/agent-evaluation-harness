import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AnswerFormatSummary } from "./answer-format.js";

describe("public answer format presentation", () => {
  it("describes scalar and list formats without inventing values or counts", () => {
    const scalar = renderToStaticMarkup(
      <AnswerFormatSummary
        format={{ type: "scalar", valueType: "decimal", nullable: true }}
      />,
    );
    expect(scalar).toContain("Single decimal value");
    expect(scalar).not.toContain("<table");
    const list = renderToStaticMarkup(
      <AnswerFormatSummary
        format={{ type: "list", itemType: "string", nullable: false }}
      />,
    );
    expect(list).toContain("List of string values");
    expect(list).not.toContain("<table");
  });
  it("shows the exact public columns without inventing reference values", () => {
    const html = renderToStaticMarkup(
      <AnswerFormatSummary
        format={{
          type: "table",
          columns: [
            { name: "country", type: "string", nullable: false },
            { name: "total", type: "decimal", nullable: true },
          ],
        }}
      />,
    );
    expect(html).toContain("Public answer format");
    expect(html).toContain("country");
    expect(html).toContain("decimal");
    expect(html).toContain("Null permitted");
    expect(html).toContain("Expected values stay private");
  });
  it("distinguishes missing historical format from a published requirement", () => {
    const html = renderToStaticMarkup(<AnswerFormatSummary />);
    expect(html).toContain("No public answer format is recorded");
    expect(html).not.toContain("<table");
  });
});
