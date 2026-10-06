import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
