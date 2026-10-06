import { expect, it } from "vitest";
import { providerExecutionFailure } from "./execution-failure.js";
import { codexCapacityNotAdmitted } from "./harness.js";
import { automaticRetryDelay } from "../domain/execution-retry.js";
import type { Json } from "../contracts.js";

it("retries native Codex capacity rejection before admission even with Tableau tools configured", () => {
  const transcript: Json[] = [
    { type: "thread.started", thread_id: "fixture-thread" },
    { type: "turn.started" },
    {
      type: "error",
      message: "Selected model is at capacity. Please try a different model.",
    },
    {
      type: "turn.failed",
      error: {
        message: "Selected model is at capacity. Please try a different model.",
      },
    },
  ];
  const input = {
    harness: "codex",
    role: "target",
    transcript,
    complete: true,
  };
  const failure = providerExecutionFailure({
    providerCode: "model_capacity",
    toolFree: false,
    toolActivity: false,
    admissionRejected: codexCapacityNotAdmitted(input),
  });
  expect(failure.retrySafety).toBe("not-started");
  expect(automaticRetryDelay(failure, 1, "managed", 0)).toBe(500);
  expect(automaticRetryDelay(failure, 2, "managed", 0)).toBe(1000);
  expect(automaticRetryDelay(failure, 3, "managed", 0)).toBeUndefined();
  expect(automaticRetryDelay(failure, 1, "external", 0)).toBeUndefined();
  for (const change of [
    { complete: false },
    { harness: "opencode" },
    { role: "researcher" },
    { conversationId: "existing" },
    {
      transcript: [
        ...transcript.slice(0, -1),
        {
          type: "item.started",
          item: { type: "mcp_tool_call", tool: "tableau.query" },
        },
        transcript.at(-1)!,
      ],
    },
    {
      transcript: [
        ...transcript.slice(0, -1),
        { type: "unknown" },
        transcript.at(-1)!,
      ],
    },
    {
      transcript: [
        {
          type: "item.completed",
          item: {
            type: "agent_message",
            text: "Selected model is at capacity. Please try a different model.",
          },
        },
      ],
    },
  ])
    expect(codexCapacityNotAdmitted({ ...input, ...change })).toBe(false);
});
it("requires structured status and a tool-free target before automatic retry is safe", () => {
  expect(
    providerExecutionFailure({
      providerCode: "model_capacity",
      toolFree: false,
      toolActivity: false,
    }),
  ).toMatchObject({
    category: "provider-capacity",
    transient: true,
    retrySafety: "unknown",
  });
  expect(
    providerExecutionFailure({
      providerCode: "model_capacity",
      toolFree: true,
      toolActivity: true,
    }),
  ).toMatchObject({ category: "provider-capacity", retrySafety: "unsafe" });
  expect(
    providerExecutionFailure({
      status: 429,
      toolFree: false,
      toolActivity: false,
    }),
  ).toMatchObject({
    category: "rate-limit",
    transient: true,
    retrySafety: "unknown",
  });
  expect(
    providerExecutionFailure({
      status: 503,
      toolFree: true,
      toolActivity: false,
    }),
  ).toMatchObject({
    category: "provider-capacity",
    retrySafety: "no-side-effects",
  });
  expect(
    providerExecutionFailure({ toolFree: true, toolActivity: false }),
  ).toMatchObject({ category: "harness", transient: false });
  expect(
    providerExecutionFailure({
      status: 429,
      toolFree: true,
      toolActivity: true,
    }).retrySafety,
  ).toBe("unsafe");
});
