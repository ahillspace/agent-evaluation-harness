import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { JsonEditor, jsonInputError } from "./json-editor.js";

it("validates JSON objects without accepting scalar or array settings", () => {
  expect(jsonInputError("{}")).toBeUndefined();
  for (const value of ["", "[]", "null", "true", "{broken}"])
    expect(jsonInputError(value)).toBeTruthy();
  expect(
    jsonInputError("{}", () => {
      throw new Error("Unsupported setting");
    }),
  ).toBe("Unsupported setting");
});
it("provides visible reference keys and a copyable example without replacing the draft", () => {
  const html = renderToStaticMarkup(
    <JsonEditor
      label="Settings"
      value="{}"
      onChange={() => {}}
      guide={{
        description: "Optional settings",
        example: { maxTurns: 40 },
        fields: [
          {
            key: "maxTurns",
            description: "Steps per question",
            values: "1 to 500",
            default: "40",
          },
        ],
      }}
    />,
  );
  expect(html).toContain("Supported settings and example");
  expect(html).toContain("Copy example");
  expect(html).toContain("Steps per question");
  expect(html).toContain("Default: 40");
});
