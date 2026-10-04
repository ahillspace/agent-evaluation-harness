import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ConnectionBinding,
  ConnectionInput,
  ConnectionRecord,
  Json,
  RuntimeCatalog,
} from "../contracts.js";
import { resolveCommand } from "./commands.js";
import {
  ConnectionStorage,
  type StoredConnection,
} from "./connection-storage.js";
import { SecretStoreError, type SecretStore } from "./secrets/store.js";

const endpoint = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, "Use a server URL without credentials, a query, or a fragment.");
const tableauSettings = z
  .object({
    server: endpoint,
    site: z.string().max(500).default(""),
    patName: z.string().min(1).max(500),
    mcpCommand: z.string().min(1).max(2000).default("npx"),
    mcpArgs: z
      .array(z.string().max(2000))
      .max(100)
      .default(["-y", "@tableau/mcp-server@4.13.3"]),
  })
  .strict();
const apiSettings = z.object({ baseUrl: endpoint.optional() }).strict();
const API_PROVIDERS: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};
export interface McpBinding {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  tools: string[];
}

export class ConnectionService {
  private readonly storage: ConnectionStorage;
  private mutation: Promise<unknown> = Promise.resolve();
  constructor(
    directory: string,
    private readonly secrets: SecretStore,
  ) {
    this.storage = new ConnectionStorage(directory);
  }
  providers(): RuntimeCatalog["connectionProviders"] {
    return [
      {
        id: "tableau",
        name: "Tableau MCP",
        kind: "tool",
        credentialFields: ["patValue"],
        settingsSchema: {
          type: "object",
          required: ["server", "patName"],
          properties: {
            server: { type: "string", title: "Server URL" },
            site: { type: "string", title: "Site content URL" },
            patName: { type: "string", title: "Token name" },
            mcpCommand: { type: "string", default: "npx" },
            mcpArgs: {
              type: "array",
              items: { type: "string" },
              default: ["-y", "@tableau/mcp-server@4.13.3"],
            },
          },
          additionalProperties: false,
        },
      },
      ...Object.keys(API_PROVIDERS).map((id) => ({
        id,
        name: `${id} API key`,
        kind: "model" as const,
        credentialFields: ["apiKey"],
        settingsSchema: {
          type: "object",
          properties: {
            baseUrl: { type: "string", title: "API base URL (optional)" },
          },
          additionalProperties: false,
        } as Json,
      })),
      {
        id: "typesafe",
        name: "TypeSafe / Jev",
        kind: "judge",
        credentialFields: ["apiKey"],
        settingsSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ];
  }
  private async records(): Promise<StoredConnection[]> {
    return (await this.storage.read()).records;
  }
  private async public(record: StoredConnection): Promise<ConnectionRecord> {
    return {
      id: record.id,
      name: record.name,
      provider: record.provider,
      settings: record.settings,
      credentialFields: record.credentialFields,
      hasCredentials: Boolean(
        record.secretReference &&
        (await this.secrets.owns(record.secretReference)),
      ),
    };
  }
  async list(): Promise<ConnectionRecord[]> {
    return Promise.all(
      (await this.records()).map((record) => this.public(record)),
    );
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(operation, operation);
    this.mutation = next.catch(() => undefined);
    return next;
  }
  settings(
    provider: string,
    value: Record<string, Json>,
  ): Record<string, Json> {
    if (provider === "typesafe") return z.object({}).strict().parse(value);
    if (provider === "tableau") {
      const settings = tableauSettings.parse(value);
      if (
        settings.mcpArgs.some((arg) =>
          /(?:api[-_]?key|password|pat[-_]?value|authorization|secret|token)[=:]/i.test(
            arg,
          ),
        )
      )
        throw new Error("MCP arguments cannot contain credentials.");
      return settings;
    }
    if (Object.hasOwn(API_PROVIDERS, provider)) return apiSettings.parse(value);
    throw new Error(`Unknown connection provider: ${provider}.`);
  }
  save(input: ConnectionInput): Promise<ConnectionRecord> {
    return this.serialize(async () => {
      const file = await this.storage.read();
      await this.storage.cleanup(file, this.secrets);
      const records = file.records;
      const existing = input.id
        ? records.find((record) => record.id === input.id)
        : undefined;
      if (input.id && !existing) throw new Error("Connection does not exist.");
      if (existing && existing.provider !== input.provider)
        throw new Error("A connection provider cannot change.");
      const settings = this.settings(input.provider, input.settings);
      const credentialFields =
        input.provider === "tableau" ? ["patValue"] : ["apiKey"];
      let secretReference = existing?.secretReference;
      const replacing = Boolean(
        input.credentials && Object.keys(input.credentials).length,
      );
      if (secretReference && (await this.secrets.owns(secretReference))) {
        const previous: Record<string, string> = JSON.parse(
          await this.secrets.read(secretReference).catch((error: unknown) => {
            if (
              replacing &&
              error instanceof SecretStoreError &&
              error.code === "missing"
            )
              return "{}";
            throw error;
          }),
        );
        if (
          Object.values(previous).some(
            (value) => value && JSON.stringify(settings).includes(value),
          )
        )
          throw new Error(
            "Credentials cannot appear in public connection settings.",
          );
      }
      if (input.credentials && Object.keys(input.credentials).length) {
        if (
          Object.keys(input.credentials).some(
            (key) => !credentialFields.includes(key),
          )
        )
          throw new Error("Unknown credential field.");
        if (credentialFields.some((key) => !input.credentials?.[key]?.trim()))
          throw new Error("Required credential is empty.");
        if (
          Object.values(input.credentials).some((value) =>
            JSON.stringify(settings).includes(value),
          )
        )
          throw new Error(
            "Credentials cannot appear in public connection settings.",
          );
        secretReference = await this.secrets.allocate();
        file.pendingDeletes.push(secretReference);
        await this.storage.write(file);
        await this.secrets.write(
          secretReference,
          JSON.stringify(input.credentials),
        );
      }
      const record: StoredConnection = {
        id: existing?.id ?? randomUUID(),
        name: input.name,
        provider: input.provider,
        settings,
        credentialFields,
        hasCredentials: Boolean(secretReference),
        secretReference,
      };
      file.records = [
        ...records.filter((item) => item.id !== record.id),
        record,
      ];
      file.pendingDeletes = file.pendingDeletes.filter(
        (reference) => reference !== secretReference,
      );
      if (
        existing?.secretReference &&
        existing.secretReference !== secretReference
      )
        file.pendingDeletes.push(existing.secretReference);
      await this.storage.write(file);
      await this.storage.cleanup(file, this.secrets);
      return this.public(record);
    });
  }
  delete(id: string): Promise<void> {
    return this.serialize(async () => {
      const file = await this.storage.read();
      const existing = file.records.find((item) => item.id === id);
      file.records = file.records.filter((item) => item.id !== id);
      if (existing?.secretReference)
        file.pendingDeletes.push(existing.secretReference);
      await this.storage.write(file);
      await this.storage.cleanup(file, this.secrets);
    });
  }
  async credentials(id: string): Promise<Record<string, string>> {
    const record = (await this.records()).find((item) => item.id === id);
    if (!record) throw new Error("Connection does not exist.");
    if (!record.secretReference)
      throw new Error(`Connection ${record.name} requires credentials.`);
    return JSON.parse(
      await this.secrets.read(record.secretReference),
    ) as Record<string, string>;
  }
  async redactionSecrets(ids: string[]): Promise<string[]> {
    const records = await this.records();
    const known = records.filter(
      (record) => ids.includes(record.id) && record.hasCredentials,
    );
    const values = await Promise.all(
      known.map((record) => this.credentials(record.id)),
    );
    return values.flatMap((credentials) => Object.values(credentials));
  }
  async freeze(binding: ConnectionBinding): Promise<ConnectionBinding> {
    const record = (await this.records()).find(
      (item) => item.id === binding.connectionId,
    );
    if (!record) throw new Error("Connection does not exist.");
    if (record.provider !== binding.provider)
      throw new Error("Connection provider does not match its binding.");
    if (!(await this.public(record)).hasCredentials)
      throw new Error(`Connection ${record.name} requires credentials.`);
    const settings = this.settings(
      record.provider,
      Object.keys(binding.settings).length ? binding.settings : record.settings,
    );
    return {
      connectionId: record.id,
      provider: record.provider,
      resourceId: binding.resourceId,
      settings,
      credentialFields: [...record.credentialFields],
    };
  }
  async materialize(
    bindings: ConnectionBinding[],
    tools: string[],
  ): Promise<{
    mcp: McpBinding[];
    env: Record<string, string>;
    secrets: string[];
  }> {
    const mcp: McpBinding[] = [];
    const env: Record<string, string> = {};
    const secrets: string[] = [];
    for (const [index, binding] of bindings.entries()) {
      const credentials = await this.credentials(binding.connectionId);
      secrets.push(...Object.values(credentials));
      if (binding.provider === "tableau") {
        if (!tools.length) continue;
        const settings = tableauSettings.parse(binding.settings);
        const command = resolveCommand(settings.mcpCommand, settings.mcpArgs);
        const selected = tools
          .map((tool) => tool.replace(/^tableau[._]/, ""))
          .filter((tool) => tool !== "*");
        mcp.push({
          name: `tableau${index || ""}`,
          command: command.executable,
          args: command.args,
          tools: selected,
          env: {
            TRANSPORT: "stdio",
            AUTH: "pat",
            SERVER: settings.server,
            SITE_NAME: settings.site,
            PAT_NAME: settings.patName,
            PAT_VALUE: credentials.patValue!,
            ENABLE_MCP_SITE_SETTINGS: "false",
            PRODUCT_TELEMETRY_ENABLED: "false",
            DISABLE_LOG_MASKING: "false",
            ...(selected.length ? { INCLUDE_TOOLS: selected.join(",") } : {}),
          },
        });
      } else {
        const key = API_PROVIDERS[binding.provider];
        if (!key) throw new Error("Unknown provider binding.");
        if (env[key])
          throw new Error("Use one credential binding per model provider.");
        env[key] = credentials.apiKey!;
        if (typeof binding.settings.baseUrl === "string")
          env[`${binding.provider.toUpperCase()}_BASE_URL`] =
            binding.settings.baseUrl;
      }
    }
    return { mcp, env, secrets };
  }
}
