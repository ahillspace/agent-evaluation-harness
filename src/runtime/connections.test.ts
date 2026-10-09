import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConnectionService } from "./connections.js";
import {
  createWindowsSecretStore,
  decryptWindowsCredential,
} from "./secrets/windows.js";
import { SecretStoreError, type SecretStore } from "./secrets/store.js";
import { migrateConnections } from "./connection-migration.js";
import { ConnectionStorage } from "./connection-storage.js";
import { randomUUID } from "node:crypto";

class MemorySecrets implements SecretStore {
  readonly values = new Map<string, string>();
  readonly prefix = randomUUID();
  failWrite = false;
  failDelete = false;
  async allocate() {
    return `${this.prefix}:${randomUUID()}`;
  }
  async owns(reference: string) {
    return reference.startsWith(`${this.prefix}:`);
  }
  async read(reference: string) {
    const value = this.values.get(reference);
    if (value === undefined)
      throw new SecretStoreError("missing", "Missing credential.");
    return value;
  }
  async write(reference: string, value: string) {
    this.values.set(reference, value);
    if (this.failWrite) throw new Error("Interrupted write.");
  }
  async delete(reference: string) {
    if (this.failDelete) throw new Error("Credential store unavailable.");
    this.values.delete(reference);
  }
}
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "aeh-connection-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const secrets = new MemorySecrets();
  return {
    directory,
    secrets,
    service: new ConnectionService(directory, secrets),
    storage: new ConnectionStorage(directory),
  };
}

const cleanup: Array<() => Promise<void>> = [];
it("freezes provider authentication and materializes only its selected secret", async () => {
  const { service } = await fixture();
  const saved = await service.save({
    name: "Gateway",
    provider: "anthropic",
    settings: { authMode: "bearer", baseUrl: "https://gateway.example/v1" },
    credentials: { apiKey: "fixture-token" },
  });
  const binding = await service.freeze({
    connectionId: saved.id,
    provider: "anthropic",
    settings: {},
    credentialFields: [],
  });
  expect(binding.settings).toEqual({
    authMode: "bearer",
    baseUrl: "https://gateway.example/v1",
  });
  const material = await service.materialize([binding], []);
  expect(material.env).toEqual({
    ANTHROPIC_AUTH_TOKEN: "fixture-token",
    ANTHROPIC_BASE_URL: "https://gateway.example/v1",
  });
  expect(JSON.stringify(binding)).not.toContain("fixture-token");
});
it("preserves arbitrary MCP environment variable names through materialization", async () => {
  const { service } = await fixture();
  const saved = await service.save({
    name: "Tableau",
    provider: "tableau",
    settings: {
      server: "https://example.tableau.com",
      site: "example",
      patName: "test",
      mcpEnv: {
        include_datasource_ids: "datasource-1",
        Future_MCP_Option: "enabled",
        AUTH_TIMEOUT: "30",
        TOKEN_LIMIT: "100",
        SECRET_PROVIDER: "local",
      },
    },
    credentials: { patValue: "fixture-pat" },
  });
  expect(saved.settings.mcpEnv).toEqual({
    include_datasource_ids: "datasource-1",
    Future_MCP_Option: "enabled",
    AUTH_TIMEOUT: "30",
    TOKEN_LIMIT: "100",
    SECRET_PROVIDER: "local",
  });
  const binding = await service.freeze({
    connectionId: saved.id,
    provider: "tableau",
    settings: {},
    credentialFields: [],
  });
  const material = await service.materialize(
    [binding],
    ["tableau.list-datasources"],
  );
  expect(material.mcp[0]?.env).toMatchObject({
    include_datasource_ids: "datasource-1",
    Future_MCP_Option: "enabled",
    AUTH_TIMEOUT: "30",
    TOKEN_LIMIT: "100",
    SECRET_PROVIDER: "local",
  });
});
it("rejects case-insensitive MCP environment duplicates and managed names", async () => {
  const { service } = await fixture();
  const settings = {
    server: "https://example.tableau.com",
    site: "example",
    patName: "test",
  };
  await expect(
    service.save({
      name: "Duplicate",
      provider: "tableau",
      settings: {
        ...settings,
        mcpEnv: { Future_Option: "one", future_option: "two" },
      },
      credentials: { patValue: "fixture-pat" },
    }),
  ).rejects.toThrow(/unique regardless of case/i);
  await expect(
    service.save({
      name: "Managed",
      provider: "tableau",
      settings: { ...settings, mcpEnv: { server: "https://other.example" } },
      credentials: { patValue: "fixture-pat" },
    }),
  ).rejects.toThrow(/cannot replace/i);
});
it("rejects NUL characters in MCP environment values", async () => {
  const { service } = await fixture();
  await expect(
    service.save({
      name: "Invalid environment",
      provider: "tableau",
      settings: {
        server: "https://example.tableau.com",
        site: "example",
        patName: "test",
        mcpEnv: { future_option: "before\0after" },
      },
      credentials: { patValue: "fixture-pat" },
    }),
  ).rejects.toThrow(/NUL/i);
});
it("rejects common credential aliases in MCP environment names", async () => {
  const { service } = await fixture();
  const settings = {
    server: "https://example.tableau.com",
    site: "example",
    patName: "test",
  };
  for (const name of [
    "MY_PAT",
    "TABLEAU_PAT",
    "API_KEY",
    "CUSTOM_AUTHORIZATION",
    "TLS_PRIVATE_KEY",
  ]) {
    await expect(
      service.save({
        name: "Credential-like environment",
        provider: "tableau",
        settings: { ...settings, mcpEnv: { [name]: "fixture-value" } },
        credentials: { patValue: "fixture-pat" },
      }),
    ).rejects.toThrow(/credential values must use/i);
  }
});
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
it("stores credential references and returns public connection records only", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aeh-secret-test-"));
  const secrets = new MemorySecrets();
  cleanup.push(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const service = new ConnectionService(directory, secrets);
  const secret = "test-secret-that-must-never-be-persisted-plain";
  const record = await service.save({
    name: "Test",
    provider: "tableau",
    settings: {
      server: "https://example.tableau.com",
      site: "example",
      patName: "test",
    },
    credentials: { patValue: secret },
  });
  expect(JSON.stringify(record)).not.toContain(secret);
  expect(
    await readFile(path.join(directory, "connections.json"), "utf8"),
  ).not.toContain(secret);
  expect((await service.credentials(record.id)).patValue).toBe(secret);
  const binding = await service.freeze({
    connectionId: record.id,
    provider: "tableau",
    settings: {},
    credentialFields: [],
  });
  expect(binding.settings.mcpArgs).toContain("@tableau/mcp-server@4.13.3");
  expect(binding.credentialFields).toEqual(["patValue"]);
  const typesafe = await service.save({
    name: "Jev",
    provider: "typesafe",
    settings: {},
    credentials: { apiKey: secret },
  });
  expect(JSON.stringify(typesafe)).not.toContain(secret);
  expect(
    await readFile(path.join(directory, "connections.json"), "utf8"),
  ).not.toContain(secret);
  expect(await service.credentials(typesafe.id)).toEqual({ apiKey: secret });
  expect(
    await service.freeze({
      connectionId: typesafe.id,
      provider: "typesafe",
      settings: {},
      credentialFields: [],
    }),
  ).toMatchObject({
    provider: "typesafe",
    settings: {},
    credentialFields: ["apiKey"],
  });
  await expect(
    service.save({
      name: "Unsafe Jev",
      provider: "typesafe",
      settings: { baseUrl: "https://elsewhere.example" },
      credentials: { apiKey: secret },
    }),
  ).rejects.toThrow();
  await expect(
    service.save({
      name: "Unsafe",
      provider: "tableau",
      settings: {
        server: "https://user:password@example.com",
        site: "",
        patName: "",
      },
    }),
  ).rejects.toThrow();
});

it("retains the current credential after an interrupted replacement and recovers staged items", async () => {
  const { directory, secrets, service, storage } = await fixture();
  const record = await service.save({
    name: "Test",
    provider: "openai",
    settings: {},
    credentials: { apiKey: "first" },
  });
  secrets.failWrite = true;
  await expect(
    service.save({ ...record, credentials: { apiKey: "replacement" } }),
  ).rejects.toThrow("Interrupted write");
  expect(await service.credentials(record.id)).toEqual({ apiKey: "first" });
  expect((await storage.read()).pendingDeletes).toHaveLength(1);
  secrets.failWrite = false;
  await migrateConnections(directory, secrets);
  expect(secrets.values.size).toBe(1);
  expect((await storage.read()).pendingDeletes).toEqual([]);
});

it("publishes replacement before retirement and retries failed cleanup after restart", async () => {
  const { directory, secrets, service, storage } = await fixture();
  const record = await service.save({
    name: "Test",
    provider: "openai",
    settings: {},
    credentials: { apiKey: "first" },
  });
  secrets.failDelete = true;
  await expect(
    service.save({ ...record, credentials: { apiKey: "replacement" } }),
  ).rejects.toThrow();
  expect(await service.credentials(record.id)).toEqual({
    apiKey: "replacement",
  });
  expect((await storage.read()).pendingDeletes).toHaveLength(1);
  secrets.failDelete = false;
  await migrateConnections(directory, secrets);
  expect(secrets.values.size).toBe(1);
  await service.delete(record.id);
  expect(secrets.values.size).toBe(0);
});

it("copied workspaces expose metadata but cannot resolve or retire source credentials", async () => {
  const source = await fixture();
  const record = await source.service.save({
    name: "Test",
    provider: "openai",
    settings: {},
    credentials: { apiKey: "first" },
  });
  const destination = await fixture();
  await writeFile(
    destination.storage.filename,
    await readFile(source.storage.filename),
  );
  expect(await destination.service.list()).toMatchObject([
    { id: record.id, hasCredentials: false },
  ]);
  await destination.service.delete(record.id);
  expect(source.secrets.values.size).toBe(1);
});

it("converts legacy records once and imports foreign metadata without ciphertext", async () => {
  const { directory, secrets, service, storage } = await fixture();
  const legacy = [
    {
      id: "legacy",
      name: "Test",
      provider: "openai",
      settings: {},
      credentialFields: ["apiKey"],
      hasCredentials: true,
      encryptedCredentials: "ciphertext",
    },
  ];
  await writeFile(storage.filename, JSON.stringify(legacy));
  await migrateConnections(directory, secrets, async () =>
    JSON.stringify({ apiKey: "first" }),
  );
  expect(await service.credentials("legacy")).toEqual({ apiKey: "first" });
  expect(await readFile(storage.filename, "utf8")).not.toContain("ciphertext");
  const copy = await fixture();
  await writeFile(copy.storage.filename, JSON.stringify(legacy));
  await migrateConnections(copy.directory, copy.secrets);
  expect(await copy.service.list()).toMatchObject([
    { id: "legacy", hasCredentials: false },
  ]);
});

it.skipIf(process.platform !== "win32")(
  "round-trips Windows DPAPI without a process supervisor",
  async () => {
    const { directory } = await fixture();
    const secrets = createWindowsSecretStore(directory);
    const reference = await secrets.allocate();
    const value = JSON.stringify({ apiKey: "fixture secret 🦊" });
    try {
      await secrets.write(reference, value);
      expect(await secrets.read(reference)).toBe(value);
      await expect(
        decryptWindowsCredential("invalid ciphertext"),
      ).rejects.toMatchObject({ code: "access_denied" });
    } finally {
      await secrets.delete(reference);
    }
  },
  30_000,
);
