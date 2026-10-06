import { expect, it } from "vitest";
import { validateModelSettings } from "./model-settings.js";

it("enforces the Converse temperature range without restricting other runtimes", () => {
  expect(() => validateModelSettings("bedrock", { temperature: 1.1 })).toThrow(
    "0 to 1",
  );
  expect(validateModelSettings("bedrock", { temperature: 0 }).temperature).toBe(
    0,
  );
  expect(validateModelSettings("bedrock", { temperature: 1 }).temperature).toBe(
    1,
  );
  expect(
    validateModelSettings("opencode", { temperature: 2 }).temperature,
  ).toBe(2);
});
