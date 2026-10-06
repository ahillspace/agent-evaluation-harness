import { it, expect } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { invokeBedrock } from "./bedrock.js";
import { createProcessSupervisor } from "./platform.js";
import type { AgentConfig, RuntimeEvent } from "../contracts.js";
import type { ProcessSupervisor } from "./process-supervisor.js";

it("retains trusted rejection status, refuses redirects, and bounds nonstream bodies", async () => {
  let mode = "reject";
  let followed = 0;
  const server = createServer((request, response) => {
    request.resume();
    if (request.url === "/redirected") followed++;
    if (mode === "redirect")
      response.writeHead(307, { location: "/redirected" }).end();
    else if (mode === "reject")
      response.writeHead(429).end("Do not expose provider error text");
    else response.writeHead(200).end("x".repeat(2000));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Fixture not listening");
    const agent: AgentConfig = {
      harness: "bedrock",
      model: "model",
      systemPrompt: "Judge",
      settings: {},
      tools: [],
      connections: [
        {
          connectionId: "fixture",
          provider: "amazon-bedrock",
          settings: {
            baseUrl: `http://127.0.0.1:${address.port}`,
            region: "us-east-1",
          },
          credentialFields: ["apiKey"],
        },
      ],
    };
    const input = {
      agent,
      directory: tmpdir(),
      prompt: "Judge evidence",
      role: "judge" as const,
      mcp: [],
      env: { AWS_BEARER_TOKEN_BEDROCK: "fixture" },
      supervisor: {} as ProcessSupervisor,
      signal: AbortSignal.timeout(5000),
      timeoutMs: 5000,
      maxOutputBytes: 1000,
      sanitize: (value: string) => value,
    };
    await expect(invokeBedrock(input)).rejects.toMatchObject({
      status: 429,
      toolActivity: false,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    mode = "redirect";
    await expect(invokeBedrock(input)).rejects.toThrow();
    expect(followed).toBe(0);
    mode = "overflow";
    await expect(invokeBedrock(input)).rejects.toMatchObject({
      code: "output_limit",
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.skipIf(!["win32", "darwin"].includes(process.platform))(
  "runs nonstream Converse through the real answer MCP bridge and resumes saved research",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "aeh-converse-"));
    const supervisor = createProcessSupervisor({ stateDirectory: directory });
    const requests: Array<{
      url: string;
      headers: Record<string, unknown>;
      body: {
        toolConfig?: { tools: Array<{ toolSpec: { name: string } }> };
        messages: Array<{ content: Array<Record<string, unknown>> }>;
      };
    }> = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const parsed = JSON.parse(body);
      requests.push({
        url: request.url ?? "",
        headers: request.headers,
        body: parsed,
      });
      const tools = parsed.toolConfig?.tools ?? [];
      const answer = tools.find((tool: { toolSpec: { name: string } }) =>
        tool.toolSpec.name.includes("submit_answer"),
      );
      const hasResult = parsed.messages.some(
        (message: { content: Array<Record<string, unknown>> }) =>
          message.content.some(
            (block: Record<string, unknown>) => block.toolResult,
          ),
      );
      const content =
        answer && !hasResult
          ? [
              {
                toolUse: {
                  toolUseId: "answer1",
                  name: answer.toolSpec.name,
                  input: { answer: [{ value: 42 }] },
                },
              },
            ]
          : [
              {
                text: '{"message":"Finished","decision":"stop","reason":"Enough evidence"}',
              },
            ];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          output: { message: { role: "assistant", content } },
          stopReason: answer && !hasResult ? "tool_use" : "end_turn",
          usage: { inputTokens: 12, outputTokens: 3 },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      await supervisor.recover();
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Fixture not listening");
      const agent: AgentConfig = {
        harness: "bedrock",
        model: "model:1",
        systemPrompt: "Evaluate public question",
        settings: { maxTurns: 3 },
        tools: [],
        connections: [
          {
            connectionId: "fixture",
            provider: "amazon-bedrock",
            settings: {
              baseUrl: `http://127.0.0.1:${address.port}`,
              region: "us-east-1",
              authMode: "bearer",
            },
            credentialFields: ["apiKey"],
          },
        ],
      };
      const events: RuntimeEvent[] = [];
      const input = {
        agent,
        directory,
        prompt: "Public question without reference rows",
        mcp: [],
        env: { AWS_BEARER_TOKEN_BEDROCK: "fixture-token" },
        supervisor,
        signal: AbortSignal.timeout(25_000),
        timeoutMs: 25_000,
        sanitize: (value: string) =>
          value.replaceAll("fixture-token", "[redacted]"),
        onEvent: (event: RuntimeEvent) => events.push(event),
      };
      const target = await invokeBedrock({ ...input, role: "target" });
      expect(
        JSON.parse(await readFile(path.join(directory, "answer.json"), "utf8")),
      ).toEqual({ answer: [{ value: 42 }] });
      expect(target.usage).toEqual({ inputTokens: 24, outputTokens: 6 });
      expect(events.some((event) => event.type === "tool.completed")).toBe(
        true,
      );
      expect(
        requests.every(
          (request) => request.url === "/model/model%3A1/converse",
        ),
      ).toBe(true);
      expect(
        requests.every(
          (request) => request.headers.authorization === "Bearer fixture-token",
        ),
      ).toBe(true);
      expect(JSON.stringify(target.transcript)).not.toContain("fixture-token");
      const first = await invokeBedrock({
        ...input,
        role: "researcher",
        prompt: "First research turn",
      });
      const second = await invokeBedrock({
        ...input,
        role: "researcher",
        prompt: "Second research turn",
        conversationId: first.conversationId,
      });
      expect(second.conversationId).toBe(first.conversationId);
      expect(requests.at(-1)?.body.messages).toHaveLength(3);
      await expect(
        invokeBedrock({
          ...input,
          role: "researcher",
          conversationId: "different",
        }),
      ).rejects.toThrow("cannot resume");
      const saved = JSON.parse(
        await readFile(
          path.join(directory, "bedrock-conversation.json"),
          "utf8",
        ),
      );
      saved.pending = true;
      const { writeFile } = await import("node:fs/promises");
      await writeFile(
        path.join(directory, "bedrock-conversation.json"),
        JSON.stringify(saved),
      );
      await expect(
        invokeBedrock({
          ...input,
          role: "researcher",
          conversationId: first.conversationId,
        }),
      ).rejects.toThrow("unresolved invocation");
      const judge = await invokeBedrock({ ...input, role: "judge" });
      expect(judge.text).toContain("Finished");
      expect(requests.at(-1)?.body.toolConfig).toBeUndefined();
    } finally {
      await supervisor.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
  35_000,
);
