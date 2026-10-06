import { expect, it } from "vitest";
import { evaluatorSettingsSchema, type Json } from "../contracts.js";
import { grade } from "./scoring.js";

const reference = (titles: string[]): Json => ({
  type: "table",
  columns: [{ name: "title", type: "string" }],
  rows: titles.map((title) => ({ title })),
  ordered: true,
});
it("compares explicit collation order independently of reference row order", async () => {
  const policy = evaluatorSettingsSchema.parse({
    sortOrder: [{ column: "title", direction: "asc" }],
    collation: { locale: "en-US", numeric: true, ignorePunctuation: true },
  });
  const gold = reference(["Title 10", "Title 2", "'Alpha"]);
  expect(
    (await grade(gold, ["'Alpha", "Title 2", "Title 10"], policy)).status,
  ).toBe("correct");
  expect(
    (await grade(gold, ["'Alpha", "Title 10", "Title 2"], policy)).details,
  ).toMatchObject({ reason: "sort_order" });
  expect(
    (await grade(gold, ["Alpha", "Title 2", "Title 10"], policy)).status,
  ).toBe("incorrect");
});
it("preserves duplicate rows by default and supports explicit distinct grain", async () => {
  const gold = reference(["A", "A", "B"]);
  expect(
    (await grade(gold, ["A", "B"], evaluatorSettingsSchema.parse({}))).status,
  ).toBe("incorrect");
  expect(
    (
      await grade(
        gold,
        ["A", "B"],
        evaluatorSettingsSchema.parse({ duplicateRows: "distinct" }),
      )
    ).status,
  ).toBe("correct");
  expect(
    (
      await grade(
        gold,
        ["A", "C"],
        evaluatorSettingsSchema.parse({ duplicateRows: "distinct" }),
      )
    ).status,
  ).toBe("incorrect");
});
it("normalizes one-cell table representations for scalars only under compatible policy", async () => {
  const answer = JSON.stringify([{ Album: "Big Ones" }]);
  const format = {
    type: "scalar",
    valueType: "string",
    nullable: false,
  } as const;
  expect(
    (
      await grade(
        { type: "string", value: "Big Ones" },
        answer,
        evaluatorSettingsSchema.parse({}),
        format,
      )
    ).status,
  ).toBe("correct");
  expect(
    (
      await grade(
        { type: "string", value: "Big Ones" },
        answer,
        evaluatorSettingsSchema.parse({ representationPolicy: "strict" }),
        format,
      )
    ).status,
  ).toBe("incorrect");
  expect(
    (
      await grade(
        { type: "string", value: "Big Ones" },
        JSON.stringify([{ Album: "Big Ones", Other: "extra" }]),
        evaluatorSettingsSchema.parse({}),
        format,
      )
    ).status,
  ).toBe("incorrect");
});
