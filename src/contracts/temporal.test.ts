import { expect, it } from "vitest";
import { temporalValue } from "./temporal.js";

it("rejects normalized impossible dates and ambiguous local instants", () => {
  for (const value of [
    "2024-02-30T00:00:00Z",
    "2023-02-29T10:00:00+01:00",
    "2024-04-31",
    "2024-01-01T24:00:00Z",
    "2024-01-01T12:00:00+25:00",
  ])
    expect(temporalValue(value, "calendar_date")).toBeUndefined();
  expect(temporalValue("2024-01-01 00:00:00", "instant")).toBeUndefined();
});
it("uses the declared calendar date without guessing timezone intent", () => {
  expect(temporalValue("2024-02-29 00:00:00", "calendar_date")).toBe(
    "2024-02-29",
  );
  expect(temporalValue("2024-03-01T00:30:00+02:00", "calendar_date")).toBe(
    "2024-03-01",
  );
  expect(temporalValue("2024-03-01T00:30:00+02:00", "instant")).toBe(
    "2024-02-29T22:30:00.000Z",
  );
  expect(temporalValue("2024-03-01T00:00:00Z", "date")).toBeUndefined();
});
