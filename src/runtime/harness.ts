import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";
import { z } from "zod";
import type {
  AgentConfig,
  Json,
  RuntimeEvent,
  PublicQuestion,
} from "../contracts.js";
import { answerFormatJsonSchema } from "../contracts/answer-format.js";
import type { McpBinding } from "./connections.js";
import type { ProcessSpec } from "./process-supervisor.js";

export const settingsSchema = z
  .object({
    authSource: z.enum(["local", "connection"]).optional(),
    maxTurns: z.number().int().min(1).max(500).default(40),
    reasoningEffort: z
      .enum([
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ])
      .optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict();

export function helperCommand(
  mode: string,
  ...args: string[]
): { command: string; args: string[] } {
  const source = fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts") ? "./mcp-host.ts" : "./mcp-host.js",
      import.meta.url,
    ),
  );
  return {
    command: process.execPath,
    args: [
      ...(source.endsWith(".ts")
        ? [
            "--import",
            pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
          ]
        : []),
      source,
      mode,
      ...args,
    ],
  };
}

export function buildHarnessCommand(input: {
  agent: AgentConfig;
  cwd: string;
  prompt: string;
  mcp: McpBinding[];
  role: "target" | "researcher" | "judge";
  conversationId?: string;
  env?: Record<string, string>;
  answerFormatPath?: string;
}): ProcessSpec {
  const { agent, cwd } = input;
  const settings = settingsSchema.parse(agent.settings);
  const env = { ...input.env };
  const bridges = input.mcp.map((binding, index) => {
    const variable = `AEH_MCP_BINDING_${index}`;
    env[variable] = JSON.stringify(binding);
    return {
      name: binding.name,
      ...helperCommand("connection", variable),
      tools: binding.tools,
    };
  });
  if (input.role === "target")
    bridges.push({
      name: "answer",
      ...helperCommand(
        "answer",
        path.join(cwd, "answer.json"),
        ...(input.answerFormatPath ? [input.answerFormatPath] : []),
      ),
      tools: ["submit_answer"],
    });
  if (input.role === "researcher")
    bridges.push({
      name: "evidence",
      ...helperCommand("evidence"),
      tools: ["read_evidence"],
    });
  if (agent.harness === "codex") {
    const disabled = [
      "apps",
      "browser_use",
      "browser_use_external",
      "browser_use_full_cdp_access",
      "computer_use",
      "goals",
      "hooks",
      "image_generation",
      "in_app_browser",
      "multi_agent",
      "plugins",
      "remote_plugin",
      "shell_tool",
      "skill_search",
      "tool_suggest",
      "unified_exec",
      "view_image",
      "sleep_tool",
    ];
    const config: Record<string, unknown> = {
      model_instructions_file: path.join(cwd, "instructions.txt"),
      web_search: "disabled",
      project_doc_max_bytes: 0,
      suppress_unstable_features_warning: true,
      approval_policy: "never",
      sandbox_mode: "read-only",
    };
    if (env.OPENAI_API_KEY) {
      config.model_provider = "aeh_openai";
      config["model_providers.aeh_openai.name"] =
        "Selected OpenAI API credentials";
      config["model_providers.aeh_openai.base_url"] =
        env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
      config["model_providers.aeh_openai.env_key"] = "OPENAI_API_KEY";
      config["model_providers.aeh_openai.wire_api"] = "responses";
      config["model_providers.aeh_openai.requires_openai_auth"] = false;
    }
    if (settings.reasoningEffort)
      config.model_reasoning_effort = settings.reasoningEffort;
    if (
      settings.temperature !== undefined ||
      settings.maxOutputTokens !== undefined
    )
      throw new Error(
        "Codex does not support temperature or maxOutputTokens in this adapter.",
      );
    for (const bridge of bridges) {
      config[`mcp_servers.${bridge.name}.command`] = bridge.command;
      config[`mcp_servers.${bridge.name}.args`] = bridge.args;
      config[`mcp_servers.${bridge.name}.required`] = true;
      config[`mcp_servers.${bridge.name}.startup_timeout_sec`] = 120;
      config[`mcp_servers.${bridge.name}.env_vars`] = Object.keys(env).filter(
        (name) => name.startsWith("AEH_"),
      );
      if (bridge.tools.length)
        config[`mcp_servers.${bridge.name}.enabled_tools`] = bridge.tools;
      for (const tool of bridge.tools)
        config[`mcp_servers.${bridge.name}.tools.${tool}.approval_mode`] =
          "approve";
    }
    const args = [
      "--strict-config",
      "exec",
      ...(input.conversationId ? ["resume", input.conversationId] : []),
      "--json",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--model",
      agent.model,
      ...(input.role === "researcher" ? [] : ["--ephemeral"]),
      ...(input.conversationId ? [] : ["--sandbox", "read-only", "--cd", cwd]),
      "--enable",
      "skip_host_skill_discovery",
      "--enable",
      "code_mode_host",
      ...disabled.flatMap((feature) => ["--disable", feature]),
      ...Object.entries(config).flatMap(([key, value]) => [
        "-c",
        `${key}=${toml(value)}`,
      ]),
      "-",
    ];
    return { executable: "codex", args, cwd, env, input: input.prompt };
  }
  if (agent.harness !== "opencode")
    throw new Error(`Unsupported harness: ${agent.harness}.`);
  const mcp = Object.fromEntries(
    bridges.map((bridge) => [
      bridge.name,
      {
        type: "local",
        command: [bridge.command, ...bridge.args],
        enabled: true,
        timeout: 120_000,
      },
    ]),
  );
  const permission: Record<string, string> = { "*": "deny" };
  for (const bridge of bridges) {
    if (bridge.tools.length)
      for (const tool of bridge.tools)
        permission[`${bridge.name}_${tool}`] = "allow";
    else permission[`${bridge.name}_*`] = "allow";
  }
  env.XDG_CONFIG_HOME = path.join(cwd, "config");
  const selectedProvider = agent.model.split("/")[0]!;
  const key = (
    {
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      google: "GOOGLE_GENERATIVE_AI_API_KEY",
    } as Record<string, string>
  )[selectedProvider];
  const provider =
    key && env[key]
      ? {
          [selectedProvider]: {
            options: {
              apiKey: `{env:${key}}`,
              ...(env[`${selectedProvider.toUpperCase()}_BASE_URL`]
                ? { baseURL: env[`${selectedProvider.toUpperCase()}_BASE_URL`] }
                : {}),
            },
          },
        }
      : {};
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    snapshot: false,
    autoupdate: false,
    subagent_depth: 0,
    instructions: [],
    mcp,
    provider,
    agent: {
      evaluation: {
        description: `${input.role} agent`,
        mode: "primary",
        model: agent.model,
        prompt: agent.systemPrompt,
        steps: settings.maxTurns,
        permission,
        ...(settings.temperature !== undefined
          ? { temperature: settings.temperature }
          : {}),
        ...(settings.maxOutputTokens !== undefined
          ? { maxOutputTokens: settings.maxOutputTokens }
          : {}),
      },
    },
  });
  return {
    executable: "opencode",
    args: [
      "--pure",
      "run",
      "--format",
      "json",
      "--dir",
      cwd,
      "--agent",
      "evaluation",
      "--model",
      agent.model,
      ...(input.conversationId ? ["--session", input.conversationId] : []),
      ...(settings.reasoningEffort
        ? ["--variant", settings.reasoningEffort]
        : []),
    ],
    cwd,
    env,
    input: input.prompt,
  };
}

export function buildTargetPrompt(
  agent: AgentConfig,
  question: PublicQuestion,
): string {
  return [
    question.text,
    question.context ?? "",
    ...agent.connections.flatMap((binding) =>
      binding.resourceId
        ? [`Connection ${binding.provider} resource: ${binding.resourceId}`]
        : [],
    ),
    "Submit your final answer with the submit_answer tool. The answer must be a JSON value.",
    ...(question.answerFormat
      ? [
          `Required public answer format: submit an array of row objects using exactly these column names and value types. Do not include a type/columns/rows wrapper. If submission reports a format error, correct it and submit again. JSON Schema: ${JSON.stringify(answerFormatJsonSchema(question.answerFormat))}`,
        ]
      : []),
    ...(agent.harness === "codex"
      ? [
          "Use functions.exec to call await tools.mcp__answer__submit_answer({answer: YOUR_JSON_VALUE}). A text-only final message does not record an answer.",
        ]
      : []),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function toml(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value))
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export function redact(text: string, secrets: string[]): string {
  for (const secret of secrets
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)) {
    text = text
      .split(JSON.stringify(secret).slice(1, -1))
      .join("[REDACTED]")
      .split(secret)
      .join("[REDACTED]");
  }
  return text;
}
export function normalizeEvent(
  harness: string,
  raw: Record<string, unknown>,
): RuntimeEvent | undefined {
  const item = record(raw.item)
    ? raw.item
    : record(raw.part)
      ? raw.part
      : undefined;
  if (raw.type === "thread.started")
    return {
      type: "conversation.started",
      message: "Provider conversation started.",
      data: { conversationId: String(raw.thread_id) },
    };
  if (item && (item.type === "mcp_tool_call" || raw.type === "tool_use")) {
    const tool = String(item.tool ?? item.name ?? "tool");
    return {
      type: raw.type === "item.started" ? "tool.started" : "tool.completed",
      message: `${tool}`,
      data: item as Json,
    };
  }
  if (
    item &&
    (item.type === "agent_message" || raw.type === "text") &&
    typeof item.text === "string"
  )
    return { type: "message", message: item.text, data: item as Json };
  if (raw.type === "turn.completed" || raw.type === "step_finish")
    return {
      type: "usage",
      message: "Provider turn completed.",
      data: (raw.usage ?? item ?? {}) as Json,
    };
  if (
    raw.type === "error" ||
    raw.type === "turn.failed" ||
    item?.type === "error"
  ) {
    const error = record(raw.error) ? raw.error : (item ?? raw);
    const details = record(error.data) ? error.data : error;
    return {
      type: "error",
      message:
        typeof details.message === "string"
          ? details.message
          : typeof raw.message === "string"
            ? raw.message
            : "The provider reported an error.",
      ...(typeof details.statusCode === "number"
        ? { data: { statusCode: details.statusCode } }
        : {}),
    };
  }
  if (harness === "opencode" && typeof raw.sessionID === "string")
    return {
      type: "provider.event",
      message: String(raw.type ?? "Provider event"),
      data: raw as Json,
    };
  return undefined;
}
