import path from "node:path";
import type { Json, RuntimeEvent } from "../contracts.js";
import type { ProcessSpec } from "./process-supervisor.js";

interface Bridge {
  name: string;
  command: string;
  args: string[];
  tools: string[];
}
export function claudeCommand(input: {
  cwd: string;
  prompt: string;
  model: string;
  maxTurns: number;
  reasoningEffort?: string;
  env: Record<string, string>;
  bridges: Bridge[];
  conversationId?: string;
  persistent: boolean;
}): ProcessSpec {
  if (input.env.ANTHROPIC_BASE_URL)
    input.env.ANTHROPIC_BASE_URL = input.env.ANTHROPIC_BASE_URL.replace(
      /\/v1\/?$/,
      "",
    );
  const servers = Object.fromEntries(
    input.bridges.map((bridge) => [
      bridge.name,
      { type: "stdio", command: bridge.command, args: bridge.args },
    ]),
  );
  const allowed = input.bridges.flatMap((bridge) =>
    bridge.tools.map((tool) => `mcp__${bridge.name}__${tool}`),
  );
  return {
    executable: "claude",
    cwd: input.cwd,
    env: input.env,
    input: input.prompt,
    args: [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--restricted",
      "--setting-sources",
      "",
      "--settings",
      JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }),
      "--tools",
      "",
      "--permission-mode",
      "dontAsk",
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({ mcpServers: servers }),
      ...(allowed.length ? ["--allowedTools", allowed.join(",")] : []),
      "--model",
      input.model,
      "--max-turns",
      String(input.maxTurns),
      "--system-prompt-file",
      path.join(input.cwd, "instructions.txt"),
      ...(input.reasoningEffort ? ["--effort", input.reasoningEffort] : []),
      ...(input.conversationId ? ["--resume", input.conversationId] : []),
      ...(input.persistent ? [] : ["--no-session-persistence"]),
    ],
  };
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export function claudeEvent(
  raw: Record<string, unknown>,
): RuntimeEvent | undefined {
  if (raw.type === "result") {
    if (raw.is_error)
      return {
        type: "error",
        message: Array.isArray(raw.errors)
          ? raw.errors.map(String).join("; ")
          : String(raw.result ?? raw.subtype ?? "Claude failed."),
      };
    return {
      type: "usage",
      message: "Provider turn completed.",
      data: {
        ...(record(raw.usage) ? raw.usage : {}),
        cost: raw.total_cost_usd ?? null,
      } as Json,
    };
  }
  const content =
    record(raw.message) && Array.isArray(raw.message.content)
      ? raw.message.content.filter(record)
      : [];
  const tools = content.filter(
    (block) => block.type === "tool_use" || block.type === "tool_result",
  );
  if (tools.length)
    return {
      type: raw.type === "assistant" ? "tool.started" : "tool.completed",
      message: tools
        .map((tool) => String(tool.name ?? tool.tool_use_id ?? "tool"))
        .join(", "),
      data: raw as Json,
    };
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("\n");
  if (text && raw.type === "assistant")
    return { type: "message", message: text, data: raw as Json };
  if (raw.type === "system")
    return {
      type: "provider.event",
      message: String(raw.subtype ?? "Claude session"),
      data: raw as Json,
    };
  return undefined;
}
