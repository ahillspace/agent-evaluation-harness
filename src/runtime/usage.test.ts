import { expect, it } from "vitest";
import { HarnessUsage, normalizeHarnessUsage } from "./usage.js";

// Sealed SpaceBunny q001: five OpenCode step-finish payloads.
const recordedSteps = [
  {
    total: 11737,
    input: 11540,
    output: 69,
    reasoning: 0,
    cache: { write: 0, read: 128 },
  },
  {
    total: 18914,
    input: 6783,
    output: 362,
    reasoning: 101,
    cache: { write: 0, read: 11668 },
  },
  {
    total: 19460,
    input: 761,
    output: 185,
    reasoning: 63,
    cache: { write: 0, read: 18451 },
  },
  {
    total: 19909,
    input: 510,
    output: 111,
    reasoning: 76,
    cache: { write: 0, read: 19212 },
  },
  {
    total: 20093,
    input: 204,
    output: 167,
    reasoning: 0,
    cache: { write: 0, read: 19722 },
  },
];

it("counts complete OpenCode context and reasoning from sealed q001 without double counting", () => {
  const usage = new HarnessUsage("opencode");
  recordedSteps.forEach((tokens, index) =>
    usage.add({ id: `step-${index}`, tokens, cost: 0 }),
  );
  expect(usage.value()).toEqual({
    inputTokens: 88979,
    cachedInputTokens: 69181,
    outputTokens: 1134,
    costUsd: 0,
  });
  usage.add({ id: "step-0", tokens: recordedSteps[0], cost: 0 });
  expect(usage.value()).toEqual({
    inputTokens: 88979,
    cachedInputTokens: 69181,
    outputTokens: 1134,
    costUsd: 0,
  });
});

it("restores cached input and separate reasoning in the real failed q003 step", () => {
  expect(
    normalizeHarnessUsage("opencode", {
      tokens: {
        total: 30568,
        input: 90,
        output: 94,
        reasoning: 1072,
        cache: { write: 0, read: 29312 },
      },
    }),
  ).toEqual({
    inputTokens: 29402,
    outputTokens: 1166,
    cachedInputTokens: 29312,
  });
});

it("restores cache writes too and supports a missing optional provider total", () => {
  expect(
    normalizeHarnessUsage("opencode", {
      tokens: {
        input: 10,
        output: 2,
        reasoning: 3,
        cache: { read: 20, write: 30 },
      },
    }),
  ).toEqual({ inputTokens: 60, outputTokens: 5, cachedInputTokens: 20 });
});

it("does not add Codex cache or reasoning subsets again", () => {
  expect(
    normalizeHarnessUsage("codex", {
      input_tokens: 100,
      cached_input_tokens: 80,
      output_tokens: 20,
      reasoning_output_tokens: 15,
    }),
  ).toEqual({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 });
});

it("leaves usage unknown for missing, invalid, or inconsistent token components", () => {
  for (const tokens of [
    { total: 100 },
    { input: 10, output: 2, cache: { read: 0, write: 0 } },
    { ...recordedSteps[0], total: 1 },
    { ...recordedSteps[0], reasoning: -1 },
    { ...recordedSteps[0], input: NaN },
    { ...recordedSteps[0], output: Infinity },
    { ...recordedSteps[0], cache: { read: "128", write: 0 } },
  ])
    expect(normalizeHarnessUsage("opencode", { tokens })).toBeUndefined();
  expect(normalizeHarnessUsage("codex", { input_tokens: 10 })).toBeUndefined();
  expect(
    normalizeHarnessUsage("other", { input_tokens: 10, output_tokens: 1 }),
  ).toBeUndefined();
});

it("does not conceal unknown usage or cost behind other observed steps", () => {
  const usage = new HarnessUsage("opencode");
  expect(usage.value()).toBeUndefined();
  usage.add({ tokens: recordedSteps[0], cost: 0 });
  usage.add({ tokens: recordedSteps[1] });
  expect(usage.value()?.costUsd).toBeUndefined();
  usage.add({ tokens: { total: 1 } });
  expect(usage.value()).toBeUndefined();
});

it("fails closed on conflicting duplicate step reports", () => {
  const usage = new HarnessUsage("opencode");
  usage.add({ id: "same", tokens: recordedSteps[0], cost: 0 });
  usage.add({ id: "same", tokens: recordedSteps[1], cost: 0 });
  expect(usage.value()).toBeUndefined();
});

it("does not invent a cached-input subtotal when Codex omits that field", () => {
  expect(
    normalizeHarnessUsage("codex", { input_tokens: 100, output_tokens: 20 }),
  ).toEqual({ inputTokens: 100, outputTokens: 20 });
});
