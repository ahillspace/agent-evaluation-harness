import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRuntime } from "./index.js";

vi.mock("./platform.js", () => ({
  createPlatformServices: () => {
    const secrets = new Map<string, string>();
    return {
      initialize: async () => undefined,
      supervisor: {
        recover: async () => ({ recovered: 0 }),
        close: async () => undefined,
      },
      secrets: {
        allocate: async () => randomUUID(),
        owns: async (id: string) => secrets.has(id),
        read: async (id: string) => secrets.get(id),
        write: async (id: string, value: string) => {
          secrets.set(id, value);
        },
        delete: async (id: string) => {
          secrets.delete(id);
        },
      },
    };
  },
}));

it("reports valid Bedrock configuration without claiming remote authentication or calling a model", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aeh-provider-probe-"));
  const runtime = createRuntime({ stateDirectory: directory });
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("No remote requests allowed"));
  try {
    const connection = await runtime.saveConnection({
      name: "Bedrock",
      provider: "amazon-bedrock",
      settings: { region: "us-east-1", authMode: "bearer" },
      credentials: { apiKey: "fixture-secret" },
    });
    const result = await runtime.testConnection(connection.id);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("configuration is valid");
    expect(result.message).toContain(
      "Credentials are verified only when a run",
    );
    expect(result.resources).toMatchObject({
      models: [],
      modelDiscovery: "unavailable",
      credentialsVerified: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["oversized", "malformed", "slow"])(
  "rejects %s model discovery through the public runtime without exposing provider contents",
  async (mode) => {
    const directory = await mkdtemp(path.join(tmpdir(), "aeh-model-catalog-"));
    const runtime = createRuntime({ stateDirectory: directory });
    const secret = "private-catalog-fixture-token";
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (mode === "oversized")
        response.end(
          JSON.stringify({
            data: [{ id: "model" }],
            private: "x".repeat(8 * 1024 * 1024),
          }),
        );
      else if (mode === "malformed") response.end(`invalid ${secret}`);
      else {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"data":[');
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const deadline = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) =>
        timeout(mode === "slow" && ms === 20_000 ? 100 : ms),
      );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing fixture port.");
      const connection = await runtime.saveConnection({
        name: "Local catalog",
        provider: "openai",
        settings: { baseUrl: `http://127.0.0.1:${address.port}/v1` },
        credentials: { apiKey: secret },
      });
      const result = await runtime.testConnection(connection.id);
      expect(result.ok).toBe(false);
      expect(result.resources).toMatchObject({
        models: [],
        modelDiscovery: "failed",
      });
      expect(result.message).toMatch(
        mode === "oversized"
          ? /byte limit/
          : mode === "malformed"
            ? /malformed/
            : /time limit/,
      );
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(requests).toEqual(["GET /v1/models"]);
    } finally {
      deadline.mockRestore();
      await runtime.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
