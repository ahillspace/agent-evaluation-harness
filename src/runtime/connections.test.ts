import { afterEach, expect, it, vi } from "vitest";
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
import { createServer } from "node:http";
import { JevClassifier } from "./jev.js";
import { jsonSchema } from "../contracts.js";

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
it("freezes and reuses optional connection metadata as JSON-compatible snapshots", async () => {
  const { service } = await fixture();
  const saved = await service.save({
    name: "Model",
    provider: "openai",
    settings: {},
    credentials: { apiKey: "fixture-json-key" },
  });
  const frozen = await service.freeze({
    connectionId: saved.id,
    provider: saved.provider,
    settings: {},
    credentialFields: [],
  });
  expect(jsonSchema.parse(frozen)).toEqual(frozen);
  expect(frozen).not.toHaveProperty("resourceId");
  const reused = await service.freeze({
    ...frozen,
    resourceId: undefined,
    resourceName: undefined,
    resourceProjectName: undefined,
  });
  expect(jsonSchema.parse(reused)).toEqual(frozen);
  expect(reused).not.toHaveProperty("resourceId");
  const metadata = {
    resourceId: "resource",
    resourceName: "",
    resourceProjectName: "Project",
  };
  const named = await service.freeze({
    connectionId: saved.id,
    provider: saved.provider,
    settings: {},
    credentialFields: [],
    ...metadata,
  });
  expect(named).toMatchObject(metadata);
  expect(await service.freeze(named)).toMatchObject(metadata);
});
it("keeps frozen endpoint A paired with key A after rotating to endpoint B and key B", async () => {
  const requests: Array<{ endpoint: string; authorization?: string }> = [];
  const listen = async (endpoint: string) => {
    const server = createServer((request, response) => {
      requests.push({ endpoint, authorization: request.headers.authorization });
      response.end("{}");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing port.");
    return `http://127.0.0.1:${address.port}/v1`;
  };
  const endpointA = await listen("A");
  const endpointB = await listen("B");
  const { service } = await fixture();
  const saved = await service.save({
    name: "Gateway",
    provider: "openai",
    settings: { baseUrl: endpointA },
    credentials: { apiKey: "frozen-key-A" },
  });
  const selection = {
    connectionId: saved.id,
    provider: saved.provider,
    settings: {},
    credentialFields: [],
  };
  const frozenA = await service.freeze(selection);
  await service.save({
    ...saved,
    settings: { baseUrl: endpointB },
    credentials: { apiKey: "replacement-key-B" },
  });
  const frozenB = await service.freeze(selection);
  for (const binding of [frozenA, frozenB]) {
    const { env } = await service.materialize([binding], []);
    await fetch(`${env.OPENAI_BASE_URL}/models`, {
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
    });
  }
  expect(requests).toEqual([
    { endpoint: "A", authorization: "Bearer frozen-key-A" },
    { endpoint: "B", authorization: "Bearer replacement-key-B" },
  ]);
});
it("keeps frozen Tableau credentials after catalog deletion", async () => {
  const { service } = await fixture();
  const saved = await service.save({
    name: "Tableau",
    provider: "tableau",
    settings: { server: "https://tableau.example", patName: "original" },
    credentials: { patValue: "original-pat" },
  });
  const frozen = await service.freeze({
    connectionId: saved.id,
    provider: saved.provider,
    settings: {},
    credentialFields: [],
  });
  await service.delete(saved.id);
  const material = await service.materialize([frozen], ["tableau.*"]);
  expect(material.mcp[0]?.env.PAT_VALUE).toBe("original-pat");
});
it("rejects legacy frozen endpoint mismatches instead of borrowing current credentials", async () => {
  const { service } = await fixture();
  const saved = await service.save({
    name: "Gateway",
    provider: "openai",
    settings: { baseUrl: "https://new.example/v1" },
    credentials: { apiKey: "replacement-key" },
  });
  await expect(
    service.materialize(
      [
        {
          connectionId: saved.id,
          provider: saved.provider,
          settings: { baseUrl: "https://old.example/v1" },
          credentialFields: ["apiKey"],
        },
      ],
      [],
    ),
  ).rejects.toThrow(/rebind/i);
});
it("binds credentials to effective endpoints while excluding resource display metadata", async () => {
  const { service } = await fixture();
  const saved = await service.save({
    name: "Default",
    provider: "openai",
    settings: {},
    credentials: { apiKey: "default-secret" },
  });
  const first = await service.freeze({
    connectionId: saved.id,
    provider: saved.provider,
    settings: {},
    credentialFields: [],
  });
  await service.save({
    ...saved,
    name: "Renamed",
    settings: {
      baseUrl: "https://API.OPENAI.COM:443/v1/",
      authMode: "api-key",
    },
  });
  const equivalent = await service.freeze({
    connectionId: saved.id,
    provider: saved.provider,
    settings: {},
    resourceId: "new-resource",
    resourceName: "Renamed resource",
    credentialFields: [],
  });
  expect(equivalent.credentialBinding).toEqual(first.credentialBinding);
  expect(await service.resolveCredentials(equivalent)).toEqual({
    apiKey: "default-secret",
  });
  await expect(
    service.resolveCredentials({
      ...first,
      settings: { baseUrl: "https://other.example/v1" },
    }),
  ).rejects.toThrow(/identity/i);
  await expect(
    service.resolveCredentials({ ...first, provider: "anthropic" }),
  ).rejects.toThrow(/identity/i);
  await expect(
    service.save({
      ...saved,
      settings: { baseUrl: "https://other.example/v1" },
    }),
  ).rejects.toThrow(/re-enter credentials/i);
});
it("protects a captured settings and credential pair during concurrent replacement", async () => {
  const { service, secrets } = await fixture();
  const saved = await service.save({
    name: "Gateway",
    provider: "openai",
    settings: { baseUrl: "https://old.example/v1" },
    credentials: { apiKey: "old-secret" },
  });
  let releaseRead!: () => void;
  let enteredRead!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enteredRead = resolve;
  });
  const originalRead = secrets.read.bind(secrets);
  vi.spyOn(secrets, "read").mockImplementationOnce(async (reference) => {
    enteredRead();
    await released;
    return originalRead(reference);
  });
  const snapshot = service.snapshot(saved.id);
  await entered;
  const replacement = service.save({
    ...saved,
    settings: { baseUrl: "https://new.example/v1" },
    credentials: { apiKey: "new-secret" },
  });
  releaseRead();
  const captured = await snapshot;
  await replacement;
  expect(captured.connection.settings.baseUrl).toBe("https://old.example/v1");
  expect(captured.credentials).toEqual({ apiKey: "old-secret" });
  expect(captured.materialize([]).env).toMatchObject({
    OPENAI_BASE_URL: "https://old.example/v1",
    OPENAI_API_KEY: "old-secret",
  });
  expect((await service.snapshot(saved.id)).credentials).toEqual({
    apiKey: "new-secret",
  });
});
it("retires unused credentials after a transient snapshot while its captured pair remains usable", async () => {
  const { service, secrets, storage } = await fixture();
  const saved = await service.save({
    name: "Probe only",
    provider: "tableau",
    settings: { server: "https://old.example", patName: "old" },
    credentials: { patValue: "probe-old-secret" },
  });
  const captured = await service.snapshot(saved.id);
  const oldReference = (await storage.read()).records[0]!.secretReference!;
  await service.save({
    ...saved,
    settings: { server: "https://new.example", patName: "new" },
    credentials: { patValue: "probe-new-secret" },
  });
  expect(secrets.values.has(oldReference)).toBe(false);
  await service.delete(saved.id);
  expect(secrets.values.size).toBe(0);
  expect((await storage.read()).retainedReferences).toEqual([]);
  expect(captured.connection.settings.server).toBe("https://old.example");
  expect(captured.credentials).toEqual({ patValue: "probe-old-secret" });
  expect(captured.materialize(["tableau.*"]).mcp[0]?.env).toMatchObject({
    SERVER: "https://old.example",
    PAT_NAME: "old",
    PAT_VALUE: "probe-old-secret",
  });
});
it("retires a Jev probe credential during rotation without changing its in-flight request", async () => {
  const { service, secrets, storage } = await fixture();
  const saved = await service.save({
    name: "Probe only",
    provider: "typesafe",
    settings: {},
    credentials: { apiKey: "probe-original-jev" },
  });
  const classifier = new JevClassifier(service);
  let authorization: string | null = null;
  const request = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, options) => {
      authorization = new Headers(options?.headers).get("authorization");
      await service.save({
        ...saved,
        credentials: { apiKey: "probe-replacement-jev" },
      });
      await service.delete(saved.id);
      return Response.json({ models: [] });
    });
  try {
    expect((await classifier.testConnection(saved.id)).ok).toBe(true);
    expect(authorization).toBe("Bearer probe-original-jev");
    expect(secrets.values.size).toBe(0);
    expect((await storage.read()).retainedReferences).toEqual([]);
  } finally {
    request.mockRestore();
    await classifier.close();
  }
});
it("redacts retained credential versions and denies copied workspace references", async () => {
  const source = await fixture();
  const saved = await source.service.save({
    name: "Provider",
    provider: "openai",
    settings: {},
    credentials: { apiKey: "historical-secret" },
  });
  const frozen = await source.service.freeze({
    connectionId: saved.id,
    provider: saved.provider,
    settings: {},
    credentialFields: [],
  });
  await source.service.save({
    ...saved,
    credentials: { apiKey: "current-secret" },
  });
  expect(await source.service.redactionSecrets([frozen])).toEqual([
    "historical-secret",
  ]);
  const copy = await fixture();
  await writeFile(
    copy.storage.filename,
    await readFile(source.storage.filename),
  );
  await expect(copy.service.resolveCredentials(frozen)).rejects.toThrow(
    /current workspace/i,
  );
  await copy.service.delete(saved.id);
  expect(await source.service.resolveCredentials(frozen)).toEqual({
    apiKey: "historical-secret",
  });
});
it("upgrades compatible legacy selections explicitly without changing historical snapshots", async () => {
  const { service, secrets, storage } = await fixture();
  const reference = await secrets.allocate();
  await secrets.write(reference, JSON.stringify({ apiKey: "legacy-secret" }));
  await writeFile(
    storage.filename,
    JSON.stringify({
      version: 2,
      records: [
        {
          id: "legacy",
          name: "Legacy",
          provider: "openai",
          settings: {},
          credentialFields: ["apiKey"],
          hasCredentials: true,
          secretReference: reference,
        },
      ],
      pendingDeletes: [],
    }),
  );
  const legacy = {
    connectionId: "legacy",
    provider: "openai",
    settings: { authMode: "api-key" },
    credentialFields: ["apiKey"],
  };
  const original = JSON.stringify(legacy);
  await expect(service.materialize([legacy], [])).rejects.toThrow(/rebind/i);
  const upgraded = await service.freeze(legacy);
  expect(upgraded.credentialBinding?.reference).not.toBe(reference);
  expect(await service.resolveCredentials(upgraded)).toEqual({
    apiKey: "legacy-secret",
  });
  expect(JSON.stringify(legacy)).toBe(original);
  expect(secrets.values.has(reference)).toBe(false);
  await expect(service.materialize([legacy], [])).rejects.toThrow(/rebind/i);
});
it("rebinds a copied snapshot only on explicit reuse with matching local credentials", async () => {
  const source = await fixture();
  const saved = await source.service.save({
    name: "Gateway",
    provider: "openai",
    settings: { baseUrl: "https://original.example/v1" },
    credentials: { apiKey: "source-secret" },
  });
  const frozen = await source.service.freeze({
    connectionId: saved.id,
    provider: saved.provider,
    settings: {},
    credentialFields: [],
  });
  const original = JSON.stringify(frozen);
  const copy = await fixture();
  await writeFile(
    copy.storage.filename,
    await readFile(source.storage.filename),
  );
  await copy.service.save({
    ...saved,
    credentials: { apiKey: "local-secret" },
  });
  await expect(copy.service.materialize([frozen], [])).rejects.toThrow(
    /rebind/i,
  );
  const rebound = await copy.service.freeze(frozen);
  expect(rebound.credentialBinding?.reference).not.toBe(
    frozen.credentialBinding?.reference,
  );
  expect(await copy.service.resolveCredentials(rebound)).toEqual({
    apiKey: "local-secret",
  });
  expect(JSON.stringify(frozen)).toBe(original);
  await expect(copy.service.materialize([frozen], [])).rejects.toThrow(
    /rebind/i,
  );
  await copy.service.save({
    ...saved,
    settings: { baseUrl: "https://other.example/v1" },
    credentials: { apiKey: "another-local-secret" },
  });
  await expect(copy.service.freeze(frozen)).rejects.toThrow(/rebind/i);
  const reopened = new ConnectionService(source.directory, source.secrets);
  await reopened.delete(saved.id);
  expect(await reopened.resolveCredentials(frozen)).toEqual({
    apiKey: "source-secret",
  });
});
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
  expect((await service.snapshot(record.id)).credentials.patValue).toBe(secret);
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
  expect((await service.snapshot(typesafe.id)).credentials).toEqual({
    apiKey: secret,
  });
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
  const stored = (await storage.read()).records.find(
    (item) => item.id === record.id,
  )!;
  const protectedValue = JSON.parse(
    await secrets.read(stored.secretReference!),
  ) as { identity: string };
  expect(
    await service.resolveCredentials({
      connectionId: record.id,
      provider: record.provider,
      settings: record.settings,
      credentialFields: record.credentialFields,
      credentialBinding: {
        version: 1,
        reference: stored.secretReference!,
        identity: protectedValue.identity,
      },
    }),
  ).toEqual({ apiKey: "first" });
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
  const stored = (await storage.read()).records.find(
    (item) => item.id === record.id,
  )!;
  const protectedValue = JSON.parse(
    await secrets.read(stored.secretReference!),
  ) as { identity: string };
  expect(
    await service.resolveCredentials({
      connectionId: record.id,
      provider: record.provider,
      settings: record.settings,
      credentialFields: record.credentialFields,
      credentialBinding: {
        version: 1,
        reference: stored.secretReference!,
        identity: protectedValue.identity,
      },
    }),
  ).toEqual({
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
  expect((await service.snapshot("legacy")).credentials).toEqual({
    apiKey: "first",
  });
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
