import { expect, it } from "vitest";
import {
  expectedAnswerSize,
  LARGE_ANSWER_TOKENS,
  JEV_ANSWER_LIMIT_TOKENS,
} from "./answer-size.js";
it("estimates the serialized answer and keeps warning thresholds explicit", () => {
  expect(
    expectedAnswerSize("x".repeat(LARGE_ANSWER_TOKENS * 4 - 2)),
  ).toMatchObject({ tokens: LARGE_ANSWER_TOKENS, severity: "warning" });
  expect(
    expectedAnswerSize("x".repeat(JEV_ANSWER_LIMIT_TOKENS * 4 - 2)),
  ).toMatchObject({ tokens: JEV_ANSWER_LIMIT_TOKENS, severity: "danger" });
  expect(expectedAnswerSize("x")).toMatchObject({
    severity: "normal",
    bytes: 3,
  });
  expect(expectedAnswerSize("界").bytes).toBe(5);
});
