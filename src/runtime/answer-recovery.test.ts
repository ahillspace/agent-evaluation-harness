import { expect, it } from "vitest";
import { buildTargetPrompt } from "./harness.js";
import { classifyExecutionFailure } from "../domain/execution-retry.js";
import { toolEventRejected } from "./execution-failure.js";

it("gives scalar submission instructions without imposing a table array", () => {
  const prompt = buildTargetPrompt(
    {
      harness: "codex",
      model: "fixture",
      systemPrompt: "",
      tools: [],
      connections: [],
      settings: {},
    },
    {
      id: "q",
      text: "Find the percentage",
      tags: [],
      answerFormat: { type: "scalar", valueType: "decimal", nullable: false },
    },
  );
  expect(prompt).toContain("scalar");
  expect(prompt).not.toContain("submit an array of row objects");
  expect(prompt).toContain("submit_answer again");
});
it("distinguishes missing answers, invalid submissions, tool rejection, and configuration failures", () => {
  expect(classifyExecutionFailure({ code: "answer_missing" }).category).toBe(
    "missing-answer",
  );
  expect(
    classifyExecutionFailure({ code: "submission_rejected" }).category,
  ).toBe("submission");
  expect(classifyExecutionFailure({ code: "tool_rejected" }).category).toBe(
    "tool",
  );
  expect(
    classifyExecutionFailure({ code: "configuration_error" }).category,
  ).toBe("configuration");
});

it("detects only structured tool rejections without interpreting answer prose", () => {
  expect(
    toolEventRejected({
      type: "tool.completed",
      message: "query",
      data: { result: { isError: true } },
    }),
  ).toBe(true);
  expect(
    toolEventRejected({
      type: "tool.completed",
      message: "query",
      data: { state: { status: "error", error: "Invalid caption" } },
    }),
  ).toBe(true);
  expect(
    toolEventRejected({
      type: "message",
      message: "The tool returned an error",
      data: { error: "quoted text" },
    }),
  ).toBe(false);
  expect(
    toolEventRejected({
      type: "tool.completed",
      message: "query",
      data: { error: null, result: { content: "error counts are zero" } },
    }),
  ).toBe(false);
});
