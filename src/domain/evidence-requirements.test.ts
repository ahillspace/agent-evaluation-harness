import { expect, it } from "vitest";
import {
  evaluatorEvidenceRequirement,
  evidenceSupports,
} from "./evidence-requirements.js";

it("uses answer evidence for built-in comparisons and requires a custom declaration", () => {
  expect(evaluatorEvidenceRequirement({ mode: "auto" })).toBe("answer");
  expect(evaluatorEvidenceRequirement({ mode: "custom" })).toBe("unspecified");
  expect(
    evaluatorEvidenceRequirement({
      mode: "custom",
      evidenceRequirement: "answer",
    }),
  ).toBe("answer");
});
it("does not infer internal actions from answer-only observation", () => {
  expect(evidenceSupports("answer-only", "answer")).toBe(true);
  expect(evidenceSupports("answer-only", "internal-activity")).toBe(false);
  expect(evidenceSupports("answer-only", "unspecified")).toBe(false);
  expect(evidenceSupports("internal-activity", "unspecified")).toBe(true);
});
