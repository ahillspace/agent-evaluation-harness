import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { jsonSchema, type ConnectionRecord } from "../contracts.js";
import type { SecretStore } from "./secrets/store.js";

export const storedConnectionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    provider: z.string(),
    settings: z.record(jsonSchema),
    credentialFields: z.array(z.string()),
    hasCredentials: z.boolean(),
    secretReference: z.string().optional(),
  })
  .strict();
export interface StoredConnection extends ConnectionRecord {
  secretReference?: string;
}
export const connectionFileSchema = z
  .object({
    version: z.literal(3),
    records: z.array(storedConnectionSchema),
    pendingDeletes: z.array(z.string()),
    retainedReferences: z.array(z.string()),
  })
  .strict();
export type ConnectionFile = z.infer<typeof connectionFileSchema>;

export async function writePrivateJson(
  filename: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class ConnectionStorage {
  readonly filename: string;
  constructor(directory: string) {
    this.filename = path.join(directory, "connections.json");
  }
  async raw(): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.filename, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return {
          version: 3,
          records: [],
          pendingDeletes: [],
          retainedReferences: [],
        };
      throw error;
    }
  }
  async read(): Promise<ConnectionFile> {
    const raw = await this.raw();
    const legacy = connectionFileSchema
      .omit({ retainedReferences: true })
      .extend({ version: z.literal(2) })
      .safeParse(raw);
    const parsed = connectionFileSchema.safeParse(
      legacy.success
        ? { ...legacy.data, version: 3, retainedReferences: [] }
        : raw,
    );
    if (!parsed.success)
      throw new Error(
        "Connection storage requires recovery or uses an unsupported format. Restart the app before changing connections.",
      );
    return parsed.data;
  }
  async write(value: ConnectionFile): Promise<void> {
    connectionFileSchema.parse(value);
    await writePrivateJson(this.filename, value);
  }
  async cleanup(file: ConnectionFile, secrets: SecretStore): Promise<void> {
    for (const reference of [...file.pendingDeletes]) {
      // Copied workspaces cannot delete credentials belonging to the source workspace.
      if (
        !file.records.some((record) => record.secretReference === reference) &&
        !file.retainedReferences.includes(reference) &&
        (await secrets.owns(reference))
      )
        await secrets.delete(reference);
      file.pendingDeletes = file.pendingDeletes.filter(
        (item) => item !== reference,
      );
      await this.write(file);
    }
  }
}
