import { expect, it } from "vitest";
import { researchTurnAccounting } from "./research-turns.js";

it("derives pending and interrupted admissions from admitted and saved turns", () => {
  expect(
    researchTurnAccounting({
      admitted: 2,
      completed: 1,
      pending: true,
      history: true,
    }),
  ).toEqual({ status: "known", interrupted: 0, nextInvocation: 3 });
  expect(
    researchTurnAccounting({
      admitted: 2,
      completed: 1,
      pending: false,
      history: true,
    }),
  ).toEqual({ status: "known", interrupted: 1, nextInvocation: 3 });
  expect(
    researchTurnAccounting({
      admitted: 3,
      completed: 1,
      pending: false,
      recordedInterrupted: 99,
      history: true,
    }),
  ).toEqual({ status: "known", interrupted: 2, nextInvocation: 4 });
});

it("initializes only empty admission history and preserves legacy fallback for incomplete records", () => {
  expect(
    researchTurnAccounting({ completed: 0, pending: false, history: false }),
  ).toEqual({
    status: "known",
    interrupted: 0,
    nextInvocation: 1,
  });
  expect(
    researchTurnAccounting({
      completed: 1,
      pending: false,
      recordedInterrupted: 3,
      history: true,
    }),
  ).toEqual({ status: "unavailable", interrupted: 3 });
  expect(
    researchTurnAccounting({ completed: 0, pending: true, history: true }),
  ).toEqual({
    status: "unavailable",
    interrupted: undefined,
  });
  expect(
    researchTurnAccounting({
      completed: 0,
      pending: false,
      recordedInterrupted: 0,
      history: true,
    }),
  ).toEqual({ status: "unavailable", interrupted: undefined });
});

it.each([-1, 0, 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  "rejects invalid admitted count %s instead of masking it",
  (admitted) => {
    expect(() =>
      researchTurnAccounting({
        admitted,
        completed: 1,
        pending: true,
        history: true,
      }),
    ).toThrow("admission history is inconsistent");
  },
);
