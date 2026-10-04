import { expect, it } from "vitest";
import { answerOnlyJevSettings } from "./answer-only-judge.js";

it("creates answer-focused judge defaults with no claim to internal trace access", () => {
  const settings = answerOnlyJevSettings();
  expect(settings.evidenceRequirement).toBe("answer");
  expect(settings.checks.evidence.instructions).toContain("returned answer");
  expect(settings.checks.evidence.criteria.supported).not.toContain(
    "tool results",
  );
  expect(settings.instructions).toContain(
    "Internal agent actions are unavailable",
  );
});
