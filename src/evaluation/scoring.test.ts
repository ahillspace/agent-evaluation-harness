import { describe, expect, it } from "vitest";
import { evaluatorSettingsSchema } from "../contracts.js";
import { grade } from "./scoring.js";

describe("deterministic scoring", () => {
  it("reports comparison limits as evaluation errors instead of incorrect answers", async () => {
    const values = Array.from({ length: 501 }, (_, index) => index);
    const result = await grade(
      values,
      values,
      evaluatorSettingsSchema.parse({ mode: "json", arrayOrderMatters: false }),
    );
    expect(result.status).toBe("error");
    expect(result.explanation).toContain("limit");
  });
  it("compares numeric answers within the frozen tolerance", async () => {
    const settings = evaluatorSettingsSchema.parse({
      mode: "numeric",
      absoluteTolerance: 0.1,
    });
    expect((await grade(10, "10.05", settings)).status).toBe("correct");
    expect((await grade(10, "10.2", settings)).status).toBe("incorrect");
    expect((await grade(10, "about ten", settings)).status).toBe("incorrect");
  });
  it("compares unordered JSON arrays without discarding duplicate values", async () => {
    const settings = evaluatorSettingsSchema.parse({
      mode: "json",
      arrayOrderMatters: false,
    });
    expect((await grade([1, 2, 2], [2, 1, 2], settings)).status).toBe(
      "correct",
    );
    expect((await grade([1, 2, 2], [1, 1, 2], settings)).status).toBe(
      "incorrect",
    );
  });
  it("keeps custom code bounded and denies ambient capabilities", async () => {
    const settings = evaluatorSettingsSchema.parse({
      mode: "custom",
      code: "return { verdict: input.answer === input.expected, explanation: typeof process };",
    });
    const result = await grade("ok", "ok", settings);
    expect(result.status).toBe("correct");
    expect(result.explanation).toBe("undefined");
    const loop = await grade(1, 1, { ...settings, code: "while (true) {}" });
    expect(loop.status).toBe("error");
  });
});
