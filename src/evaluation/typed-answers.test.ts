import { describe, expect, it } from "vitest";
import { evaluatorSettingsSchema, type Json } from "../contracts.js";
import { gradeTypedAnswer } from "./typed-answers.js";

const settings = evaluatorSettingsSchema.parse({ absoluteTolerance: 0.01 });
const numeric = (value: string): Json => ({
  type: "numeric",
  value,
  value_type: "decimal",
});
const table = (rows: Json[], ordered = false): Json => ({
  type: "table",
  columns: [
    { name: "state", type: "string" },
    { name: "sales", type: "decimal" },
  ],
  rows,
  ordered,
  ...(ordered ? { order_by: ["sales"] } : {}),
});

describe("typed analytical answers", () => {
  it("normalizes primitive arrays only for one-column tables without changing coverage or cell validation", () => {
    const expected = {
      type: "table",
      columns: [{ name: "title", type: "string" }],
      rows: [{ title: "Alpha" }, { title: "Beta" }, { title: "Beta" }],
      ordered: true,
    };
    expect(
      gradeTypedAnswer(expected, ["Alpha", "Beta", "Beta"], settings)?.status,
    ).toBe("correct");
    expect(
      gradeTypedAnswer(
        expected,
        JSON.stringify(["Alpha", "Beta", "Beta"]),
        settings,
      )?.status,
    ).toBe("correct");
    expect(
      gradeTypedAnswer(expected, ["Alpha", "Beta", "Gamma"], settings)?.status,
    ).toBe("incorrect");
    expect(
      gradeTypedAnswer(expected, ["Alpha", "Beta"], settings)?.status,
    ).toBe("incorrect");
    expect(
      gradeTypedAnswer(expected, ["Alpha", "Beta", 42], settings)?.status,
    ).toBe("incorrect");
    expect(
      gradeTypedAnswer(expected, ["Beta", "Alpha", "Beta"], settings)?.status,
    ).toBe("incorrect");
    expect(
      gradeTypedAnswer(table([{ state: "A", sales: 1 }]), ["A", 1], settings)
        ?.status,
    ).toBe("incorrect");
  });
  it("uses only declared unambiguous column aliases without relaxing values or row coverage", () => {
    const expected = table([
      { state: "A", sales: 10 },
      { state: "B", sales: 5 },
    ]);
    const configured = evaluatorSettingsSchema.parse({
      columnAliases: { state: ["region"], sales: ["total"] },
    });
    expect(
      gradeTypedAnswer(
        expected,
        [
          { region: "A", total: 10 },
          { region: "B", total: 5 },
        ],
        configured,
      )?.status,
    ).toBe("correct");
    expect(
      gradeTypedAnswer(
        expected,
        [
          { region: "A", total: 11 },
          { region: "B", total: 5 },
        ],
        configured,
      )?.status,
    ).toBe("incorrect");
    expect(
      gradeTypedAnswer(expected, [{ region: "A", total: 10 }], configured)
        ?.status,
    ).toBe("incorrect");
    expect(
      gradeTypedAnswer(
        expected,
        [
          { region: "A", state: "A", total: 10 },
          { region: "B", total: 5 },
        ],
        configured,
      )?.status,
    ).toBe("incorrect");
    expect(
      gradeTypedAnswer(
        expected,
        [
          { area: "A", total: 10 },
          { area: "B", total: 5 },
        ],
        configured,
      )?.status,
    ).toBe("incorrect");
    expect(() =>
      evaluatorSettingsSchema.parse({
        columnAliases: { state: ["x"], sales: ["x"] },
      }),
    ).toThrow();
  });
  it("decodes JSON-encoded table submissions without changing the stored value or generic strings", () => {
    const expected = table([{ state: "A", sales: 10 }]);
    const answer = JSON.stringify([{ state: "A", sales: 10 }]);
    expect(gradeTypedAnswer(expected, answer, settings)?.status).toBe(
      "correct",
    );
    expect(answer).toBe('[{"state":"A","sales":10}]');
    expect(
      gradeTypedAnswer(expected, "The answer is A with 10", settings)?.status,
    ).toBe("incorrect");
    expect(
      gradeTypedAnswer({ type: "string", value: '["A"]' }, '["A"]', settings)
        ?.status,
    ).toBe("correct");
  });
  it("accepts natural JSON scalars and table rows without requiring private expectation wrappers", () => {
    expect(gradeTypedAnswer(numeric("12.345"), 12.35, settings)?.status).toBe(
      "correct",
    );
    expect(gradeTypedAnswer(numeric("12.345"), 12.37, settings)?.status).toBe(
      "incorrect",
    );
    expect(
      gradeTypedAnswer(
        { type: "string", value: "California", aliases: ["CA"] },
        "ca",
        settings,
      )?.status,
    ).toBe("correct");
    const rows = [{ state: "California", sales: 12.35 }];
    expect(
      gradeTypedAnswer(
        table([{ state: "California", sales: "12.345" }]),
        rows,
        settings,
      )?.status,
    ).toBe("correct");
    expect(
      gradeTypedAnswer(
        table(rows),
        [{ state: "California", sales: "bad" }],
        settings,
      )?.status,
    ).toBe("incorrect");
    expect(
      gradeTypedAnswer({ type: "null_scalar" }, null, settings)?.status,
    ).toBe("correct");
    expect(
      gradeTypedAnswer({ type: "empty_table" }, [], settings)?.status,
    ).toBe("correct");
    expect(
      gradeTypedAnswer({ type: "unanswerable" }, null, settings)?.status,
    ).toBe("incorrect");
    expect(
      gradeTypedAnswer(numeric("42"), { type: "string", value: "42" }, settings)
        ?.status,
    ).toBe("incorrect");
  });
  it("uses exact decimal tolerance at the boundary without losing large integer precision", () => {
    expect(
      gradeTypedAnswer(numeric("12.345"), numeric("12.35"), settings)?.status,
    ).toBe("correct");
    expect(
      gradeTypedAnswer(numeric("0.1"), numeric("0.11"), settings)?.status,
    ).toBe("correct");
    expect(
      gradeTypedAnswer(
        numeric("9007199254740993"),
        numeric("9007199254740992"),
        settings,
      )?.status,
    ).toBe("incorrect");
    expect(
      gradeTypedAnswer(numeric("1"), numeric("1.02"), settings)?.status,
    ).toBe("incorrect");
  });

  it("preserves semantic states rather than treating all absent values as equivalent", () => {
    for (const type of [
      "empty_table",
      "null_scalar",
      "unanswerable",
      "clarification",
    ]) {
      expect(gradeTypedAnswer({ type }, { type }, settings)?.status).toBe(
        "correct",
      );
      expect(
        gradeTypedAnswer({ type }, { type: "target_failure" }, settings)
          ?.status,
      ).toBe("incorrect");
    }
    expect(
      gradeTypedAnswer(
        { type: "empty_table" },
        { type: "null_scalar" },
        settings,
      )?.status,
    ).toBe("incorrect");
    expect(
      gradeTypedAnswer(
        { type: "numeric", value: "NaN" },
        numeric("1"),
        settings,
      )?.status,
    ).toBe("error");
  });

  it("accepts configured aliases and distinguishes unknown JSON objects", () => {
    expect(
      gradeTypedAnswer(
        { type: "string", value: "California", aliases: ["CA"] },
        { type: "string", value: " ca " },
        settings,
      )?.status,
    ).toBe("correct");
    expect(
      gradeTypedAnswer({ type: "business-record", value: 5 }, {}, settings),
    ).toBeNull();
  });

  it("accepts tied ranks in either order and rejects reversed non-tied ranks", () => {
    const expected = table(
      [
        { state: "A", sales: 10 },
        { state: "B", sales: 10 },
        { state: "C", sales: 5 },
      ],
      true,
    );
    expect(
      gradeTypedAnswer(
        expected,
        table([
          { state: "B", sales: 10 },
          { state: "A", sales: 10 },
          { state: "C", sales: 5 },
        ]),
        settings,
      )?.status,
    ).toBe("correct");
    expect(
      gradeTypedAnswer(
        expected,
        table([
          { state: "C", sales: 5 },
          { state: "A", sales: 10 },
          { state: "B", sales: 10 },
        ]),
        settings,
      )?.status,
    ).toBe("incorrect");
  });

  it("never drops duplicate rows or ignores additional returned rows", () => {
    const expected = table([
      { state: "A", sales: 1 },
      { state: "A", sales: 1 },
    ]);
    expect(
      gradeTypedAnswer(
        expected,
        table([
          { state: "A", sales: 1 },
          { state: "B", sales: 1 },
        ]),
        settings,
      )?.status,
    ).toBe("incorrect");
    expect(
      gradeTypedAnswer(
        expected,
        table([
          { state: "A", sales: 1 },
          { state: "A", sales: 1 },
          { state: "B", sales: 1 },
        ]),
        settings,
      )?.status,
    ).toBe("incorrect");
  });

  it("finds a full row assignment when numeric tolerances overlap", () => {
    const columns = [{ name: "value", type: "decimal" }];
    const expected = {
      type: "table",
      columns,
      rows: [{ value: "0.1" }, { value: "0" }],
    };
    const answer = {
      type: "table",
      columns,
      rows: [{ value: "0.05" }, { value: "0.2" }],
    };
    const tolerant = evaluatorSettingsSchema.parse({ absoluteTolerance: 0.11 });
    expect(gradeTypedAnswer(expected, answer, tolerant)?.status).toBe(
      "correct",
    );
  });

  it("reports malformed expected tables as evaluation errors", () => {
    expect(
      gradeTypedAnswer(
        { type: "table", columns: [], rows: [] },
        table([]),
        settings,
      )?.status,
    ).toBe("error");
    expect(
      gradeTypedAnswer(
        table([{ state: "A" }]),
        table([{ state: "A", sales: 0 }]),
        settings,
      )?.status,
    ).toBe("error");
  });
});
