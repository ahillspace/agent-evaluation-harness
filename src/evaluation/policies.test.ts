import { expect, it } from "vitest";
import { evaluatorSettingsSchema, type Json } from "../contracts.js";
import { grade } from "./scoring.js";
import { validateReference } from "./typed-answers.js";
const settings = (value: unknown = {}) => evaluatorSettingsSchema.parse(value);
const table = (rows: Json[]) => ({
  type: "table",
  columns: [
    { name: "name", type: "string" },
    { name: "amount", type: "decimal" },
  ],
  rows,
});
it("compares declared decimal places without relaxing unrelated values", async () => {
  expect(
    (await grade(12.345, 12.35, settings({ decimalPlaces: 2 }))).status,
  ).toBe("correct");
  expect(
    (await grade(-12.345, -12.35, settings({ decimalPlaces: 2 }))).status,
  ).toBe("correct");
  expect(
    (await grade(12.344, 12.35, settings({ decimalPlaces: 2 }))).status,
  ).toBe("incorrect");
  expect(
    (
      await grade(
        "9007199254740993.125",
        "9007199254740993.13",
        settings({ mode: "numeric", decimalPlaces: 2 }),
      )
    ).status,
  ).toBe("correct");
  expect(
    (
      await grade(
        12.344,
        12.35,
        settings({ decimalPlaces: 2, absoluteTolerance: 100 }),
      )
    ).status,
  ).toBe("incorrect");
});
it("extracts an explicit JSON pointer and unwraps only singletons", async () => {
  expect(
    (
      await grade(
        "A",
        { result: ["A"] },
        settings({ answerPath: "/result", unwrapSingleton: true }),
      )
    ).status,
  ).toBe("correct");
  expect(
    (
      await grade(
        "A",
        { result: ["A", "B"] },
        settings({ answerPath: "/result", unwrapSingleton: true }),
      )
    ).status,
  ).toBe("incorrect");
  expect(
    (await grade(null, {}, settings({ answerPath: "/missing" }))).status,
  ).toBe("incorrect");
});
it("uses column-specific rounding and retains row membership", async () => {
  const expected = table([{ name: "A", amount: 12.345 }]);
  const policy = settings({ columnRules: { amount: { decimalPlaces: 2 } } });
  expect(
    (await grade(expected, [{ name: "A", amount: 12.35 }], policy)).status,
  ).toBe("correct");
  expect(
    (await grade(expected, [{ name: "B", amount: 12.35 }], policy)).status,
  ).toBe("incorrect");
});
it("accepts cutoff alternatives only from a complete ranked pool", async () => {
  const expected = table([
    { name: "A", amount: 10 },
    { name: "B", amount: 7 },
    { name: "C", amount: 7 },
    { name: "D", amount: 1 },
  ]);
  const policy = settings({
    topK: {
      count: 2,
      orderBy: [{ column: "amount", direction: "desc" }],
      referenceComplete: true,
    },
  });
  expect(
    (
      await grade(
        expected,
        [
          { name: "A", amount: 10 },
          { name: "C", amount: 7 },
        ],
        policy,
      )
    ).status,
  ).toBe("correct");
  for (const answer of [
    [
      { name: "B", amount: 7 },
      { name: "C", amount: 7 },
    ],
    [
      { name: "A", amount: 10 },
      { name: "X", amount: 7 },
    ],
    [
      { name: "C", amount: 7 },
      { name: "A", amount: 10 },
    ],
  ])
    expect((await grade(expected, answer, policy)).status).toBe("incorrect");
});
it("separates reference review and malformed references from incorrect answers", async () => {
  expect(
    (
      await grade(
        42,
        9,
        settings({
          referenceDisposition: "needs_review",
          referenceNote: "Source coverage disputed",
        }),
      )
    ).status,
  ).toBe("unscorable");
  expect((await grade(table([{ name: "A" }]), [], settings())).status).toBe(
    "error",
  );
});

it("rejects fractional values for reference integer columns regardless of submitted declarations", async () => {
  const expected = {
    type: "table",
    columns: [{ name: "count", type: "integer" }],
    rows: [{ count: 1 }],
  };
  const actual = {
    type: "table",
    columns: [{ name: "count", type: "decimal" }],
    rows: [{ count: "1.0000001" }],
  };
  expect((await grade(expected, actual, settings())).status).toBe("incorrect");
});
it("rejects contradictory semantic states and unsupported numeric declarations", async () => {
  for (const [expected, actual] of [
    [{ type: "empty_table" }, { type: "empty_table", rows: [{ x: 1 }] }],
    [{ type: "null_scalar" }, { type: "null_scalar", value: 42 }],
  ] as [Json, Json][]) {
    expect((await grade(expected, actual, settings())).status).toBe(
      "incorrect",
    );
    expect((await grade(actual, expected, settings())).status).toBe("error");
  }
  expect(
    (
      await grade(
        { type: "numeric", value: 1, value_type: "nonsense" },
        1,
        settings(),
      )
    ).status,
  ).toBe("error");
});

it("compares calendar dates only with explicit policy and rejects impossible dates", async () => {
  expect(
    (
      await grade(
        "2024-02-29 00:00:00",
        "2024-02-29",
        settings({ dateComparison: "calendar_date" }),
      )
    ).status,
  ).toBe("correct");
  expect(
    (
      await grade(
        "2024-02-30",
        "2024-03-01",
        settings({ dateComparison: "calendar_date" }),
      )
    ).status,
  ).toBe("error");
  const expected = {
    type: "table",
    columns: [{ name: "day", type: "date" }],
    rows: [{ day: "2024-02-29" }],
  };
  expect(
    (
      await grade(
        expected,
        [{ day: "2024-02-29T23:00:00Z" }],
        settings({ columnRules: { day: { dateComparison: "calendar_date" } } }),
      )
    ).status,
  ).toBe("correct");
});

it("compares equivalent zoned instants without losing submillisecond differences", async () => {
  const policy = settings({ dateComparison: "instant" });
  expect(
    (
      await grade(
        "2024-03-01T00:30:00.123456789+02:00",
        "2024-02-29T22:30:00.123456789Z",
        policy,
      )
    ).status,
  ).toBe("correct");
  expect(
    (
      await grade(
        "2024-03-01T00:30:00.123456789+02:00",
        "2024-02-29T22:30:00.123456788Z",
        policy,
      )
    ).status,
  ).toBe("incorrect");
  expect(
    (await grade("2024-03-01T00:30:00Z", "2024-03-01T00:30:00-00:00", policy))
      .status,
  ).toBe("incorrect");
  expect(
    (await grade("2024-01-01T00:00:00+23:59", "2023-12-31T00:01:00Z", policy))
      .status,
  ).toBe("correct");
});

it("preserves duplicate cutoff rows and accepts fewer than k only for a smaller pool", async () => {
  const pool = table([
    { name: "A", amount: 10 },
    { name: "A", amount: 10 },
    { name: "B", amount: 7 },
  ]);
  const policy = settings({
    topK: {
      count: 2,
      orderBy: [{ column: "amount", direction: "desc" }],
      referenceComplete: true,
    },
  });
  expect(
    (
      await grade(
        pool,
        [
          { name: "A", amount: 10 },
          { name: "B", amount: 7 },
        ],
        policy,
      )
    ).status,
  ).toBe("incorrect");
  expect(
    (
      await grade(
        table([{ name: "A", amount: 10 }]),
        [{ name: "A", amount: 10 }],
        policy,
      )
    ).status,
  ).toBe("correct");
});

it("ranks temporal columns at full precision and applies declared calendar semantics", async () => {
  const expected = {
    type: "table",
    columns: [{ name: "moment", type: "datetime" }],
    rows: [
      { moment: "2024-01-01T00:00:00.0001Z" },
      { moment: "2024-01-01T00:00:00Z" },
    ],
  };
  const policy = settings({
    topK: {
      count: 1,
      orderBy: [{ column: "moment", direction: "asc" }],
      referenceComplete: true,
    },
  });
  expect(
    (await grade(expected, [{ moment: "2024-01-01T00:00:00Z" }], policy))
      .status,
  ).toBe("correct");
  expect(
    (await grade(expected, [{ moment: "2024-01-01T00:00:00.0001Z" }], policy))
      .status,
  ).toBe("incorrect");
});

it("rejects unknown policy columns and invalid ordering before grading", () => {
  const reference = table([{ name: "A", amount: 1 }]);
  expect(() =>
    validateReference(
      reference,
      settings({ columnRules: { missing: { decimalPlaces: 2 } } }),
    ),
  ).toThrow("declared");
  expect(() =>
    validateReference(reference, settings({ orderBy: ["missing"] })),
  ).toThrow("Ordering");
  expect(() =>
    validateReference(
      reference,
      settings({ columnRules: { name: { decimalPlaces: 2 } } }),
    ),
  ).toThrow("Numeric");
});

it("rejects comparison modes that would ignore authored policies", async () => {
  const reference = table([{ name: "A", amount: 1 }]);
  for (const mode of ["json", "exact", "text", "numeric"])
    expect(() =>
      validateReference(
        reference,
        settings({ mode, columnRules: { amount: { decimalPlaces: 2 } } }),
      ),
    ).toThrow("Auto");
  for (const mode of ["json", "exact", "text"])
    expect(() =>
      validateReference(1.2, settings({ mode, decimalPlaces: 2 })),
    ).toThrow("Decimal");
  expect(() =>
    validateReference("1.2", settings({ decimalPlaces: 2 })),
  ).toThrow("Decimal");
  expect(() =>
    validateReference(reference, settings({ dateComparison: "calendar_date" })),
  ).toThrow("column rules");
  expect(() =>
    validateReference(reference, settings({ unwrapSingleton: true })),
  ).toThrow("table");
  expect(() =>
    validateReference(
      "2024-01-01",
      settings({ mode: "json", dateComparison: "calendar_date" }),
    ),
  ).toThrow("date policy");
  expect(
    (
      await grade(
        "A",
        { value: ["A"] },
        settings({
          mode: "exact",
          answerPath: "/value",
          unwrapSingleton: true,
        }),
      )
    ).status,
  ).toBe("correct");
});

it("keeps actual null mismatches distinct from malformed table submissions", async () => {
  const outcome = await grade(
    table([{ name: "A", amount: 1 }]),
    [{ name: "A", amount: null }],
    settings(),
  );
  expect(outcome.status).toBe("incorrect");
  expect(outcome.details).toMatchObject({ reason: "row_membership" });
});

it("does not turn nearby ranks into ties through numeric tolerances", async () => {
  const expected = {
    ...table([
      { name: "A", amount: 1.001 },
      { name: "B", amount: 1.002 },
    ]),
    ordered: true,
    order_by: ["amount"],
  };
  expect(
    (
      await grade(
        expected,
        [
          { name: "B", amount: 1.002 },
          { name: "A", amount: 1.001 },
        ],
        settings({ columnRules: { amount: { decimalPlaces: 2 } } }),
      )
    ).status,
  ).toBe("incorrect");
});

it("uses escaped pointer tokens without searching or equating null with missing", async () => {
  expect(
    (
      await grade(
        null,
        { "a/b": { "~key": null } },
        settings({ answerPath: "/a~1b/~0key" }),
      )
    ).status,
  ).toBe("correct");
  expect(
    (await grade(null, [], settings({ unwrapSingleton: true }))).status,
  ).toBe("incorrect");
  expect((await grade("A", "Some prose says A", settings())).status).toBe(
    "incorrect",
  );
});
