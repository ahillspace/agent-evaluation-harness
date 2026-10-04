import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Answer } from "./answer.js";
import type { Json } from "../contracts.js";

describe("recorded answer presentation", () => {
  it("renders flat record arrays with their submitted keys and full raw JSON", () => {
    const value = [
      { country: "USA", number_of_invoices: 91 },
      { country: "Canada", number_of_invoices: null },
    ];
    const html = renderToStaticMarkup(<Answer value={value} />);
    expect(html).toContain('<th scope="col">country</th>');
    expect(html).toContain('<th scope="col">number_of_invoices</th>');
    expect(html).toContain("NULL");
    expect(html).toContain("2 recorded rows");
    expect(html).toContain("Recorded answer JSON");
    expect(html).not.toContain("billing_country");
    expect(value[1]?.number_of_invoices).toBeNull();
  });
  it("preserves JSON fallback for empty, nested, and heterogeneous arrays", () => {
    const cases: Json[] = [
      [],
      [{ value: { nested: 12 } }],
      [{ country: "USA" }, { count: 91 }],
      [{ country: "USA" }, "other"],
    ];
    for (const value of cases) {
      const html = renderToStaticMarkup(<Answer value={value} />);
      expect(html).not.toContain("<table");
      expect(html).toContain('class="json-view"');
    }
  });
  it("keeps a decimal string exact", () => {
    const html = renderToStaticMarkup(
      <Answer value={{ type: "numeric", value: "9007199254740993.125" }} />,
    );
    expect(html).toContain("9007199254740993.125");
  });
  it("renders typed tables with their real columns and null values", () => {
    const html = renderToStaticMarkup(
      <Answer
        value={{
          type: "table",
          columns: [
            { name: "region", type: "string" },
            { name: "revenue", type: "decimal" },
          ],
          rows: [{ region: "West", revenue: null }],
        }}
      />,
    );
    expect(html).toContain('<th scope="col">region</th>');
    expect(html).toContain("West");
    expect(html).toContain("NULL");
  });
  it("distinguishes a recorded null answer from missing evidence", () => {
    expect(renderToStaticMarkup(<Answer value={null} />)).toContain("NULL");
    expect(renderToStaticMarkup(<Answer value={undefined} />)).toContain(
      "Not recorded",
    );
  });
});
