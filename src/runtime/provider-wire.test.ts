import { it, expect } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProcessSupervisor } from "./platform.js";
import { buildHarnessCommand } from "./harness.js";
import { providerEnvironment } from "./model-providers.js";

// Explicitly opted in: requires an installed OpenCode, never calls a live model.
it.skipIf(process.env.AEH_LOCAL_PROVIDER_WIRE !== "1")(
  "sends Anthropic and Bedrock bearer credentials to their configured loopback gateways",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "aeh-wire-"));
    const supervisor = createProcessSupervisor({ stateDirectory: directory });
    const requests: Array<{
      url: string;
      authorization: string | undefined;
      apiKey: string | string[] | undefined;
    }> = [];
    const server = createServer((request, response) => {
      requests.push({
        url: request.url ?? "",
        authorization: request.headers.authorization,
        apiKey: request.headers["x-api-key"],
      });
      request.resume();
      response.writeHead(403, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "error",
          error: {
            type: "permission_error",
            message: "Local fixture rejection",
          },
          message: "Local fixture rejection",
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
        throw new Error("No fixture port");
      const endpoint = `http://127.0.0.1:${address.port}`;
      for (const [provider, model, suffix] of [
        ["anthropic", "claude-sonnet-4-5", "/v1"],
        ["amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0", ""],
      ]) {
        const env = providerEnvironment(
          provider!,
          {
            authMode: "bearer",
            baseUrl: endpoint + suffix,
            ...(provider === "amazon-bedrock" ? { region: "us-east-1" } : {}),
          },
          "local-fixture-token",
        );
        const command = buildHarnessCommand({
          agent: {
            harness: "opencode",
            model: `${provider}/${model}`,
            systemPrompt: "Fixture",
            settings: { maxTurns: 1 },
            connections: [],
            tools: [],
          },
          cwd: directory,
          prompt: "Reply fixture",
          mcp: [],
          role: "judge",
          env: { ...env, OPENCODE_DISABLE_MODELS_FETCH: "true" },
        });
        const before = requests.length;
        const result = await supervisor.run({
          ...command,
          timeoutMs: 30_000,
          processLimit: 8,
        });
        expect(result.timedOut).toBe(false);
        expect(requests.length, result.stderr + result.stdout).toBeGreaterThan(
          before,
        );
        const request = requests[before]!;
        expect(request.authorization).toBe("Bearer local-fixture-token");
        expect(request.apiKey).toBeUndefined();
        expect(request.url).toContain(
          provider === "anthropic" ? "/v1/messages" : "/converse-stream",
        );
      }
    } finally {
      await supervisor.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
  80_000,
);
