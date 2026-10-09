import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentConfig, Json, RuntimeEvent } from "../contracts.js";
import { jsonSchema } from "../contracts.js";
import { validateModelSettings } from "../contracts/model-settings.js";
import { createHarnessBridges, record } from "./harness.js";
import { safeFetchDiagnostics } from "./safe-fetch-diagnostics.js";
import type { McpBinding } from "./connections.js";
import { McpSession } from "./mcp-session.js";
import { providerExecutionFailure } from "./execution-failure.js";
import {
  cleanupFailure,
  type ProcessSupervisor,
} from "./process-supervisor.js";

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.array(z.record(jsonSchema)),
});
const conversationSchema = z.object({
  id: z.string(),
  fingerprint: z.string(),
  pending: z.boolean(),
  messages: z.array(messageSchema),
});
type Message = z.infer<typeof messageSchema>;
const responseSchema = z.object({
  output: z.object({ message: messageSchema }),
  stopReason: z.string(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
});
export class BedrockFailure extends Error {
  usage?: { inputTokens: number; outputTokens: number };
  toolActivity = false;
  providerDiagnostics?: { name?: string; code?: string };
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    providerDiagnostics?: { name?: string; code?: string },
  ) {
    super(message);
    this.providerDiagnostics = providerDiagnostics;
  }
}

export async function invokeBedrock(input: {
  agent: AgentConfig;
  directory: string;
  prompt: string;
  role: "target" | "researcher" | "judge";
  mcp: McpBinding[];
  env: Record<string, string>;
  supervisor: ProcessSupervisor;
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputBytes?: number;
  answerFormatPath?: string;
  conversationId?: string;
  onEvent?: (event: RuntimeEvent) => void;
  sanitize: (value: string) => string;
}) {
  input = {
    ...input,
    signal: AbortSignal.any([
      input.signal,
      AbortSignal.timeout(input.timeoutMs),
    ]),
  };
  const settings = validateModelSettings("bedrock", input.agent.settings);
  const connection = input.agent.connections.find(
    (binding) => binding.provider === "amazon-bedrock",
  );
  if (!connection || !input.env.AWS_BEARER_TOKEN_BEDROCK)
    throw new BedrockFailure(
      "Select saved Bedrock bearer credentials.",
      "configuration_error",
    );
  const endpoint = String(
    connection.settings.baseUrl ??
      `https://bedrock-runtime.${connection.settings.region}.amazonaws.com`,
  ).replace(/\/+$/, "");
  const url = `${endpoint}/model/${encodeURIComponent(input.agent.model)}/converse`;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ agent: input.agent, role: input.role }))
    .digest("hex");
  const filename = path.join(input.directory, "bedrock-conversation.json");
  let state: z.infer<typeof conversationSchema> = {
    id: randomUUID(),
    fingerprint,
    pending: false,
    messages: [],
  };
  if (input.conversationId) {
    try {
      state = conversationSchema.parse(
        JSON.parse(await readFile(filename, "utf8")),
      );
    } catch {
      throw new BedrockFailure(
        "The saved Bedrock conversation is unavailable.",
        "continuity_failed",
      );
    }
    if (
      state.id !== input.conversationId ||
      state.fingerprint !== fingerprint ||
      state.pending
    )
      throw new BedrockFailure(
        "The Bedrock conversation cannot resume with changed settings or an unresolved invocation.",
        "continuity_failed",
      );
  }
  const save = async () => {
    if (input.role !== "researcher") return;
    const temporary = filename + ".tmp";
    await writeFile(temporary, input.sanitize(JSON.stringify(state)), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, filename);
  };
  const transcript: Json[] = [];
  let toolCalls = 0;
  let bytes = 0,
    inputTokens = 0,
    outputTokens = 0,
    toolActivity = false;
  let completed:
    | {
        text: string;
        conversationId: string;
        transcript: Json[];
        usage: { inputTokens: number; outputTokens: number };
        cleanup: "complete" | "unavailable";
      }
    | undefined;
  const emit = (event: RuntimeEvent) => {
    const encoded = input.sanitize(JSON.stringify(event));
    bytes += Buffer.byteLength(encoded);
    if (bytes > (input.maxOutputBytes ?? 4_000_000))
      throw new BedrockFailure(
        "The invocation exceeded its output limit.",
        "output_limit",
      );
    const safe = JSON.parse(encoded) as RuntimeEvent;
    transcript.push(safe as unknown as Json);
    input.onEvent?.(safe);
  };
  const env = { ...input.env };
  const bridges = createHarnessBridges(
    {
      mcp: input.mcp,
      role: input.role,
      cwd: input.directory,
      answerFormatPath: input.answerFormatPath,
    },
    env,
  );
  const clients: McpSession[] = [];
  const tools = new Map<
    string,
    { client: McpSession; name: string; spec: Json }
  >();
  const execute = async () => {
    try {
      for (const bridge of bridges) {
        const client = new McpSession(input.supervisor, {
          executable: bridge.command,
          args: bridge.args,
          env,
          cwd: input.directory,
          timeoutMs: input.timeoutMs,
          signal: input.signal,
          processLimit: 5,
          maxOutputBytes: input.maxOutputBytes ?? 4_000_000,
        });
        clients.push(client);
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          const page = await client.request(
            "tools/list",
            cursor ? { cursor } : {},
          );
          if (!record(page) || !Array.isArray(page.tools))
            throw new BedrockFailure(
              "MCP returned an invalid tool catalog.",
              "infrastructure_failure",
            );
          for (const tool of page.tools) {
            if (
              !record(tool) ||
              typeof tool.name !== "string" ||
              !bridge.tools.includes(tool.name)
            )
              continue;
            const name = `${bridge.name}_${tool.name}`.replace(
              /[^a-zA-Z0-9_-]/g,
              "_",
            );
            const key =
              name.length <= 64
                ? name
                : name.slice(0, 48) +
                  createHash("sha256").update(name).digest("hex").slice(0, 16);
            if (tools.has(key))
              throw new BedrockFailure(
                "MCP tool names conflict.",
                "configuration_error",
              );
            tools.set(key, {
              client,
              name: tool.name,
              spec: {
                toolSpec: {
                  name: key,
                  description: String(tool.description ?? tool.name),
                  inputSchema: { json: jsonSchema.parse(tool.inputSchema) },
                },
              },
            });
          }
          cursor =
            typeof page.nextCursor === "string" ? page.nextCursor : undefined;
          if (cursor) {
            if (seen.has(cursor) || seen.size >= 20)
              throw new BedrockFailure(
                "MCP tool catalog pagination did not complete.",
                "infrastructure_failure",
              );
            seen.add(cursor);
          }
        } while (cursor);
      }
      state.messages.push({ role: "user", content: [{ text: input.prompt }] });
      await save();
      emit({
        type: "conversation.created",
        message: "Bedrock conversation established.",
        data: { conversationId: state.id },
      });
      for (let turn = 0; turn < settings.maxTurns; turn++) {
        input.signal.throwIfAborted();
        state.pending = true;
        await save();
        const response = await fetch(url, {
          method: "POST",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${input.env.AWS_BEARER_TOKEN_BEDROCK}`,
          },
          signal: input.signal,
          body: JSON.stringify({
            system: [{ text: input.agent.systemPrompt }],
            messages: state.messages,
            inferenceConfig: {
              maxTokens: settings.maxOutputTokens ?? 4096,
              ...(settings.temperature === undefined
                ? {}
                : { temperature: settings.temperature }),
            },
            ...(tools.size
              ? {
                  toolConfig: {
                    tools: [...tools.values()].map((tool) => tool.spec),
                  },
                }
              : {}),
          }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new BedrockFailure(
            `Bedrock rejected the request (HTTP ${response.status}).`,
            "infrastructure_failure",
            response.status,
          );
        }
        const reader = response.body?.getReader();
        if (!reader)
          throw new BedrockFailure(
            "Bedrock returned an empty response.",
            "evidence_failure",
          );
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > (input.maxOutputBytes ?? 4_000_000))
              throw new BedrockFailure(
                "Bedrock response exceeds the output limit.",
                "output_limit",
              );
            chunks.push(chunk.value);
          }
        } finally {
          await reader.cancel();
        }
        const body = responseSchema.parse(
          JSON.parse(input.sanitize(Buffer.concat(chunks).toString("utf8"))),
        );
        if (body.output.message.role !== "assistant")
          throw new BedrockFailure(
            "Bedrock returned an invalid assistant message.",
            "evidence_failure",
          );
        inputTokens += body.usage.inputTokens;
        outputTokens += body.usage.outputTokens;
        emit({
          type: "usage",
          message: "Bedrock response completed.",
          data: body.usage,
        });
        state.messages.push(body.output.message);
        const text = body.output.message.content
          .filter((block) => typeof block.text === "string")
          .map((block) => block.text)
          .join("\n");
        if (text) emit({ type: "message", message: text });
        const calls = body.output.message.content.filter((block) =>
          record(block.toolUse),
        );
        if (!calls.length) {
          if (
            body.stopReason !== "end_turn" &&
            body.stopReason !== "stop_sequence"
          )
            throw new BedrockFailure(
              `Bedrock stopped before completing the answer (${body.stopReason}).`,
              "target_failure",
            );
          state.pending = false;
          await save();
          completed = {
            text,
            conversationId: state.id,
            transcript,
            usage: { inputTokens, outputTokens },
            cleanup: "complete",
          };
          return completed;
        }
        const results: Message["content"] = [];
        for (const block of calls) {
          if (++toolCalls > settings.maxTurns)
            throw new BedrockFailure(
              "The configured tool call limit was reached.",
              "target_failure",
            );
          const call = block.toolUse as Record<string, Json>;
          const tool =
            typeof call.name === "string" ? tools.get(call.name) : undefined;
          if (
            !tool ||
            typeof call.toolUseId !== "string" ||
            !record(call.input)
          )
            throw new BedrockFailure(
              "Bedrock requested an unconfigured or invalid tool.",
              "target_failure",
            );
          toolActivity = true;
          emit({
            type: "tool.started",
            message: tool.name,
            data: { tool: tool.name, arguments: call.input },
          });
          const result = jsonSchema.parse(
            await tool.client.request("tools/call", {
              name: tool.name,
              arguments: call.input as Record<string, Json>,
            }),
          );
          emit({ type: "tool.completed", message: tool.name, data: result });
          results.push({
            toolResult: {
              toolUseId: call.toolUseId,
              content: [{ json: result }],
              status: record(result) && result.isError ? "error" : "success",
            },
          });
        }
        state.messages.push({ role: "user", content: results });
        await save();
      }
      throw new BedrockFailure(
        "The configured model turn limit was reached.",
        "target_failure",
      );
    } catch (error) {
      let failure: BedrockFailure;
      if (error instanceof BedrockFailure) failure = error;
      else {
        const diagnostic = safeFetchDiagnostics(error);
        const providerCode = diagnostic.codes[0];
        const providerName = diagnostic.names[0];
        const suffix = providerCode
          ? ` (${providerCode})`
          : providerName
            ? ` (${providerName})`
            : "";
        failure = new BedrockFailure(
          error instanceof z.ZodError
            ? "The provider or tool response failed validation."
            : `The Bedrock transport or tool invocation did not complete${suffix}.`,
          error instanceof z.ZodError
            ? "evidence_failure"
            : "infrastructure_failure",
          undefined,
          providerCode || providerName
            ? {
                ...(providerName ? { name: providerName } : {}),
                ...(providerCode ? { code: providerCode } : {}),
              }
            : undefined,
        );
      }
      failure.usage = { inputTokens, outputTokens };
      failure.toolActivity = toolActivity;
      throw failure;
    }
  };
  let failure: unknown;
  let failedExecution = false;
  try {
    await execute();
  } catch (error) {
    failure = error;
    failedExecution = true;
  }
  const settled = await Promise.allSettled(
    clients.map((client) => client.close()),
  );
  const failed = settled.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") {
    if (completed) completed.cleanup = "unavailable";
    else {
      throw cleanupFailure(
        failure instanceof BedrockFailure
          ? {
              message: input.sanitize(failure.message),
              code: failure.code,
              ...(failure.status === undefined
                ? {}
                : { statusCode: failure.status }),
              ...(failure.providerDiagnostics
                ? { providerDiagnostics: failure.providerDiagnostics }
                : {}),
            }
          : undefined,
        providerExecutionFailure({
          status:
            failure instanceof BedrockFailure ? failure.status : undefined,
          toolFree: input.role === "target" && input.agent.tools.length === 0,
          toolActivity,
          usage: { inputTokens, outputTokens },
        }),
      );
    }
  }
  if (failedExecution) throw failure;
  if (!completed)
    throw new BedrockFailure("Bedrock did not complete.", "target_failure");
  return completed;
}
