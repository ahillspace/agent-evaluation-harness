import { expect, it } from "vitest";
import { buildHarnessCommand, normalizeEvent } from "./harness.js";
import { normalizeHarnessUsage } from "./usage.js";
const agent = {
  harness: "claude",
  model: "sonnet",
  systemPrompt: "Only configured instructions",
  settings: { maxTurns: 8 },
  tools: [],
  connections: [],
};
it("isolates Claude builtins and resumes the exact researcher conversation", () => {
  const command = buildHarnessCommand({
    agent,
    cwd: "/isolated",
    prompt: "question",
    mcp: [],
    role: "researcher",
    conversationId: "session",
  });
  expect(command.executable).toBe("claude");
  expect(command.args).toContain("--restricted");
  expect(command.args).toContain("--strict-mcp-config");
  expect(
    command.args.slice(
      command.args.indexOf("--tools"),
      command.args.indexOf("--tools") + 2,
    ),
  ).toEqual(["--tools", ""]);
  expect(command.args).toContain("mcp__evidence__read_evidence");
  expect(
    command.args.slice(
      command.args.indexOf("--resume"),
      command.args.indexOf("--resume") + 2,
    ),
  ).toEqual(["--resume", "session"]);
  expect(command.args).not.toContain("--no-session-persistence");
});
it("normalizes Claude content, errors, and cumulative usage", () => {
  expect(
    normalizeEvent("claude", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello" }] },
    }),
  ).toMatchObject({ type: "message", message: "Hello" });
  expect(
    normalizeEvent("claude", {
      type: "result",
      is_error: true,
      errors: ["Capacity exhausted"],
    }),
  ).toMatchObject({ type: "error", message: "Capacity exhausted" });
  const event = normalizeEvent("claude", {
    type: "result",
    is_error: false,
    usage: {
      input_tokens: 10,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
      output_tokens: 3,
    },
    total_cost_usd: 0.1,
  });
  expect(normalizeHarnessUsage("claude", event?.data)).toEqual({
    inputTokens: 35,
    outputTokens: 3,
    cachedInputTokens: 20,
    costUsd: 0.1,
  });
});
