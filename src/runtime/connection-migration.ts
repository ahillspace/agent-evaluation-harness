import { readFile, rm } from "node:fs/promises";
import { z } from "zod";
import {
  ConnectionStorage,
  storedConnectionSchema,
  writePrivateJson,
  type ConnectionFile,
} from "./connection-storage.js";
import type { SecretStore } from "./secrets/store.js";

const legacySchema = z.array(
  storedConnectionSchema
    .omit({ secretReference: true })
    .extend({ encryptedCredentials: z.string().optional() })
    .strict(),
);

/** One startup conversion keeps legacy ciphertext out of normal connection operations. */
export async function migrateConnections(
  directory: string,
  secrets: SecretStore,
  decodeLegacy?: (value: string) => Promise<string>,
): Promise<void> {
  const storage = new ConnectionStorage(directory);
  const raw = await storage.raw();
  const journal = `${storage.filename}.migration`;
  let pending: string[] = [];
  try {
    pending = z
      .array(z.string())
      .parse(JSON.parse(await readFile(journal, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!Array.isArray(raw)) {
    const current = await storage.read();
    const live = new Set(
      current.records.map((record) => record.secretReference),
    );
    current.pendingDeletes.push(
      ...pending.filter((reference) => !live.has(reference)),
    );
    await storage.cleanup(current, secrets);
    await rm(journal, { force: true });
    return;
  }
  for (const reference of pending)
    if (await secrets.owns(reference)) await secrets.delete(reference);
  pending = [];
  const records = legacySchema.parse(raw);
  const file: ConnectionFile = { version: 2, records: [], pendingDeletes: [] };
  for (const { encryptedCredentials, ...record } of records) {
    let secretReference: string | undefined;
    if (encryptedCredentials && decodeLegacy) {
      const value = await decodeLegacy(encryptedCredentials);
      z.record(z.string()).parse(JSON.parse(value));
      secretReference = await secrets.allocate();
      pending.push(secretReference);
      await writePrivateJson(journal, pending);
      await secrets.write(secretReference, value);
    }
    file.records.push({
      ...record,
      hasCredentials: Boolean(secretReference),
      secretReference,
    });
  }
  await storage.write(file);
  await rm(journal, { force: true });
}
