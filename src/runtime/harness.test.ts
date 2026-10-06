import { expect, it } from "vitest";
import {
  buildHarnessCommand,
  normalizeEvent,
  redact,
  buildTargetPrompt,
} from "./harness.js";
import type { AgentConfig } from "../contracts.js";

const agent: AgentConfig = {
  harness: "codex",
  model: "catalog/model",
  systemPrompt: "Configured system prompt",
  tools: [],
  connections: [],
  settings: { maxTurns: 20 },
};
it("isolates target tools and places the configured system prompt in the system configuration", () => {
  const command = buildHarnessCommand({
    agent,
    cwd: "C:/isolated",
    prompt: "public question",
    mcp: [],
    role: "target",
  });
  expect(command.args).toContain("--ignore-user-config");
  expect(command.args).toContain("--ignore-rules");
  expect(command.args).toContain("shell_tool");
  expect(command.args).toContain("multi_agent");
  expect(command.args).toContain("--strict-config");
  expect(
    command.args.some((argument) =>
      argument.startsWith("model_instructions_file="),
    ),
  ).toBe(true);
  expect(command.args).not.toContain(
    "--dangerously-bypass-approvals-and-sandbox",
  );
});
it("shows exactly the public answer schema in the target prompt and forwards its file only to the target bridge", () => {
  const format = {
    type: "table" as const,
    columns: [
      { name: "billing_country", type: "string" as const, nullable: false },
      { name: "COUNT(*)", type: "integer" as const, nullable: false },
    ],
  };
  const prompt = buildTargetPrompt(agent, {
    id: "q",
    text: "Count invoices by country.",
    tags: [],
    answerFormat: format,
  });
  expect(prompt).toContain("billing_country");
  expect(prompt).toContain("COUNT(*)");
  expect(prompt).toContain("additionalProperties");
  const target = buildHarnessCommand({
    agent,
    cwd: "C:/isolated",
    prompt,
    mcp: [],
    role: "target",
    answerFormatPath: "C:/isolated/answer-format.json",
  });
  expect(target.args.join(" ")).toContain("answer-format.json");
  const judge = buildHarnessCommand({
    agent,
    cwd: "C:/isolated",
    prompt: "Judge",
    mcp: [],
    role: "judge",
    answerFormatPath: "C:/isolated/answer-format.json",
  });
  expect(judge.args.join(" ")).not.toContain("answer-format.json");
  expect(
    buildTargetPrompt(agent, { id: "old", text: "Question", tags: [] }),
  ).not.toContain("billing_country");
});
it("OpenCode denies default tools and enables only configured MCP bindings", () => {
  const command = buildHarnessCommand({
    agent: { ...agent, harness: "opencode" },
    cwd: "C:/isolated",
    prompt: "public question",
    mcp: [],
    role: "judge",
  });
  const config = JSON.parse(command.env!.OPENCODE_CONFIG_CONTENT!);
  expect(config.agent.evaluation.permission).toEqual({ "*": "deny" });
  expect(config.mcp).toEqual({});
  expect(config.subagent_depth).toBe(0);
});
it("normalizes tool evidence without discarding tool names or outputs", () => {
  const event = normalizeEvent("codex", {
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: "tableau",
      tool: "query",
      arguments: { x: 1 },
      result: { data: 42 },
    },
  });
  expect(event?.type).toBe("tool.completed");
  expect(event?.message).toContain("query");
  expect(event?.data).toMatchObject({ result: { data: 42 } });
});
it("redacts raw and JSON escaped credentials", () => {
  const secret = 's"ecret';
  expect(redact(JSON.stringify({ value: secret }), [secret])).not.toContain(
    "ecret",
  );
});
it("selects explicit API credentials without putting their values in command arguments", () => {
  const command = buildHarnessCommand({
    agent,
    cwd: "C:/isolated",
    prompt: "question",
    mcp: [],
    role: "target",
    env: {
      OPENAI_API_KEY: "sensitive-key",
      OPENAI_BASE_URL: "https://example.com/v1",
    },
  });
  expect(command.args).toContain('model_provider="aeh_openai"');
  expect(command.args.join(" ")).not.toContain("sensitive-key");
  expect(command.env?.OPENAI_API_KEY).toBe("sensitive-key");
});
it("classifies Codex capacity only from trusted provider error envelopes", () => {
  for (const raw of [
    {
      type: "error",
      message: "Selected model is at capacity. Please try a different model.",
    },
    {
      type: "turn.failed",
      error: { message: "Unavailable", code: "model_busy" },
    },
  ])
    expect(normalizeEvent("codex", raw)?.data).toMatchObject({
      providerCode: "model_capacity",
    });
  expect(
    normalizeEvent("codex", {
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "Selected model is at capacity. Please try a different model.",
      },
    })?.type,
  ).toBe("message");
  expect(
    normalizeEvent("codex", {
      type: "item.completed",
      item: {
        type: "error",
        message: "Selected model is at capacity. Please try a different model.",
      },
    })?.data,
  ).toBeUndefined();
});
