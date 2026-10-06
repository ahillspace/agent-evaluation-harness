import { expect, it } from "vitest";
import {
  automaticRetryDelay,
  classifyExecutionFailure,
} from "./execution-retry.js";
it("never infers safe retry from model text or an unknown failure", () => {
  expect(
    classifyExecutionFailure(new Error("429 overload retry me")).retrySafety,
  ).toBe("unknown");
  expect(
    automaticRetryDelay(
      { category: "rate-limit", transient: true, retrySafety: "unknown" },
      1,
      "managed",
      0,
    ),
  ).toBeUndefined();
});
it("bounds safe retries and respects retry-after without shortening it", () => {
  const failure = {
    category: "rate-limit",
    transient: true,
    retrySafety: "not-started",
    retryAfterMs: 2000,
  } as const;
  expect(automaticRetryDelay(failure, 1, "managed", 0)).toBe(2000);
  expect(automaticRetryDelay(failure, 3, "managed", 0)).toBeUndefined();
  expect(automaticRetryDelay(failure, 1, "external", 0)).toBeUndefined();
  expect(
    automaticRetryDelay({ ...failure, retryAfterMs: 120000 }, 1, "managed", 0),
  ).toBeUndefined();
});
