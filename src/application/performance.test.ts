import { expect, it } from "vitest";
import { aggregateUsage } from "./performance.js";

it("preserves reported token totals while separating pending and missing reports", () => {
  const total = aggregateUsage([
    {
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 60,
        costUsd: 0.1,
      },
    },
    { usage: { inputTokens: 50, outputTokens: 10 } },
    { pending: true },
    {},
  ]);
  expect(total).toMatchObject({
    inputTokens: 150,
    outputTokens: 30,
    cachedInputTokens: 60,
    costUsd: 0.1,
  });
  expect(total.reporting.inputTokens).toEqual({
    reported: 2,
    missing: 1,
    pending: 1,
  });
  expect(total.reporting.outputTokens).toEqual({
    reported: 2,
    missing: 1,
    pending: 1,
  });
  expect(total.reporting.cachedInputTokens).toEqual({
    reported: 1,
    missing: 2,
    pending: 1,
  });
  expect(total.reporting.costUsd).toEqual({
    reported: 1,
    missing: 2,
    pending: 1,
  });
});

it("uses unknown only when no report exists and zero when no invocation occurred", () => {
  expect(aggregateUsage([])).toMatchObject({
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costUsd: 0,
  });
  expect(aggregateUsage([{ pending: true }, {}])).toMatchObject({
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    costUsd: null,
    reporting: { inputTokens: { reported: 0, missing: 1, pending: 1 } },
  });
  expect(
    aggregateUsage([
      { usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 } },
    ]),
  ).toMatchObject({
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costUsd: null,
  });
});

it("tracks reporting independently for each field without adding cached input twice", () => {
  const total = aggregateUsage([
    { usage: { inputTokens: 100, cachedInputTokens: 90 } },
    { usage: { outputTokens: 20 } },
  ]);
  expect(total.inputTokens).toBe(100);
  expect(total.outputTokens).toBe(20);
  expect(total.cachedInputTokens).toBe(90);
  expect(total.reporting.inputTokens).toEqual({
    reported: 1,
    missing: 1,
    pending: 0,
  });
  expect(total.reporting.outputTokens).toEqual({
    reported: 1,
    missing: 1,
    pending: 0,
  });
});

it("projects uncached input only from reports with a valid cache breakdown", () => {
  const total = aggregateUsage([
    { usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 60 } },
    { usage: { inputTokens: 50, outputTokens: 10 } },
    { pending: true },
  ]);
  expect(total).toMatchObject({
    inputTokens: 150,
    uncachedInputTokens: 40,
    cachedInputTokens: 60,
    outputTokens: 30,
  });
  expect(total.reporting.uncachedInputTokens).toEqual({
    reported: 1,
    missing: 1,
    pending: 1,
  });
  expect(
    aggregateUsage([{ usage: { inputTokens: 10, cachedInputTokens: 20 } }])
      .uncachedInputTokens,
  ).toBeNull();
  expect(
    aggregateUsage([{ usage: { inputTokens: 10 } }]).uncachedInputTokens,
  ).toBeNull();
  expect(aggregateUsage([]).uncachedInputTokens).toBe(0);
});
