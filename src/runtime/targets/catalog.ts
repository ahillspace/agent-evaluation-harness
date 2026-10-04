import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  targetSchema,
  type ExternalTargetConfig,
  type ExternalTargetInput,
  type ExternalTargetRecord,
} from "../../contracts.js";
import { writePrivateJson } from "../connection-storage.js";
import type { SecretStore } from "../secrets/store.js";

const storedTarget = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(200),
    target: targetSchema.refine((target) => target.kind === "external"),
  })
  .strict();
const storageSchema = z
  .object({
    version: z.literal(2),
    records: z.array(storedTarget),
    pendingDeletes: z.array(z.string()),
    retainedReferences: z.array(z.string()),
  })
  .strict();
type CatalogFile = z.infer<typeof storageSchema>;
import type { TargetCredentialBinding } from "./contracts.js";
export type { TargetCredentialBinding } from "./contracts.js";
export class ExternalTargetCatalog {
  private readonly filename: string;
  private mutation: Promise<unknown> = Promise.resolve();
  constructor(
    directory: string,
    private readonly secrets: SecretStore,
    private readonly validate: (
      target: ExternalTargetConfig,
    ) => ExternalTargetConfig,
    private readonly binding: (
      target: ExternalTargetConfig,
    ) => TargetCredentialBinding,
  ) {
    this.filename = path.join(directory, "external-targets.json");
  }
  private async read(): Promise<CatalogFile> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.filename, "utf8"));
      const legacy = storageSchema
        .omit({ retainedReferences: true })
        .extend({ version: z.literal(1) })
        .safeParse(raw);
      return legacy.success
        ? { ...legacy.data, version: 2, retainedReferences: [] }
        : storageSchema.parse(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return {
          version: 2,
          records: [],
          pendingDeletes: [],
          retainedReferences: [],
        };
      throw new Error(
        "External agent storage is unavailable or uses an unsupported format.",
      );
    }
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(operation, operation);
    this.mutation = next.catch(() => undefined);
    return next;
  }
  private identity(target: ExternalTargetConfig): string {
    const bound = this.binding(target).bind(undefined);
    const canonical = (value: unknown): string => {
      if (value && typeof value === "object" && !Array.isArray(value))
        return `{${Object.entries(value)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
          .join(",")}}`;
      if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
      return JSON.stringify(value);
    };
    return createHash("sha256")
      .update(
        canonical({
          adapterId: bound.adapterId,
          adapterVersion: bound.adapterVersion,
          configuration: bound.configuration,
        }),
      )
      .digest("hex");
  }
  private async cleanup(file: CatalogFile): Promise<void> {
    for (const reference of [...file.pendingDeletes]) {
      const referenced = file.records.some(
        (record) =>
          this.binding(record.target as ExternalTargetConfig).reference ===
          reference,
      );
      if (
        !referenced &&
        !file.retainedReferences.includes(reference) &&
        (await this.secrets.owns(reference))
      )
        await this.secrets.delete(reference);
      file.pendingDeletes = file.pendingDeletes.filter(
        (item) => item !== reference,
      );
      await writePrivateJson(this.filename, file);
    }
  }
  recover(): Promise<void> {
    return this.serialize(async () => this.cleanup(await this.read()));
  }
  /** Published snapshots own their credential versions for the workspace lifetime. */
  retain(target: ExternalTargetConfig): Promise<void> {
    return this.serialize(async () => {
      const validated = this.validate(target);
      const binding = this.binding(validated);
      if (!binding.required) return;
      await this.credential(validated);
      const file = await this.read();
      if (!file.retainedReferences.includes(binding.reference!)) {
        file.retainedReferences.push(binding.reference!);
        await writePrivateJson(this.filename, file);
      }
    });
  }
  private async public(
    record: CatalogFile["records"][number],
  ): Promise<ExternalTargetRecord> {
    const target = record.target as ExternalTargetConfig;
    const binding = this.binding(target);
    return {
      id: record.id,
      name: record.name,
      target,
      hasCredentials:
        !binding.required ||
        Boolean(
          binding.reference && (await this.secrets.owns(binding.reference)),
        ),
    };
  }
  async list(): Promise<ExternalTargetRecord[]> {
    return Promise.all(
      (await this.read()).records.map((record) => this.public(record)),
    );
  }
  async credential(target: ExternalTargetConfig): Promise<string | undefined> {
    const binding = this.binding(this.validate(target));
    if (!binding.required) return undefined;
    if (!binding.reference || !(await this.secrets.owns(binding.reference)))
      throw new Error(
        "Rebind this external agent's credential in the current workspace before launch.",
      );
    try {
      const secret = z
        .object({
          version: z.literal(1),
          identity: z.string(),
          value: z.string().min(1),
        })
        .strict()
        .parse(JSON.parse(await this.secrets.read(binding.reference)));
      if (secret.identity !== this.identity(target))
        throw new Error("Credential binding mismatch");
      return secret.value;
    } catch {
      throw new Error(
        "The external agent credential is unavailable. Rebind it before launch.",
      );
    }
  }
  async resolve(target: ExternalTargetConfig): Promise<ExternalTargetConfig> {
    const validated = this.validate(target);
    await this.credential(validated);
    return structuredClone(validated);
  }
  save(input: ExternalTargetInput): Promise<ExternalTargetRecord> {
    return this.serialize(async () => {
      const name = z.string().trim().min(1).max(200).parse(input.name);
      const file = await this.read();
      await this.cleanup(file);
      const existing = input.id
        ? file.records.find((record) => record.id === input.id)
        : undefined;
      if (input.id && !existing)
        throw new Error("The external agent does not exist.");
      let target = this.validate({ ...input.target, name });
      const binding = this.binding(target);
      const previous = existing
        ? this.binding(existing.target as ExternalTargetConfig)
        : undefined;
      const replacing = input.credential !== undefined;
      // A saved binding cannot transfer silently to a changed endpoint or configuration.
      if (
        binding.required &&
        !replacing &&
        existing &&
        this.identity(target) !==
          this.identity(existing.target as ExternalTargetConfig)
      )
        throw new Error(
          "Re-enter the credential when changing external agent settings.",
        );
      let reference = previous?.reference;
      if (!existing && !replacing) reference = binding.reference;
      if (input.credential !== undefined) {
        if (!binding.required)
          throw new Error("This external agent does not use a credential.");
        if (
          !input.credential.trim() ||
          input.credential.length > 32_000 ||
          /[\r\n\0]/u.test(input.credential)
        )
          throw new Error(
            "Use a nonempty credential without control characters.",
          );
        if (
          JSON.stringify({ name, target }).includes(
            JSON.stringify(input.credential).slice(1, -1),
          )
        )
          throw new Error(
            "Credentials cannot appear in public external agent configuration.",
          );
        reference = await this.secrets.allocate();
        file.pendingDeletes.push(reference);
        await writePrivateJson(this.filename, file);
        await this.secrets.write(
          reference,
          JSON.stringify({
            version: 1,
            identity: this.identity(target),
            value: input.credential,
          }),
        );
      }
      target = binding.bind(binding.required ? reference : undefined);
      if (binding.required) {
        const value = await this.credential(target);
        if (
          value &&
          JSON.stringify({ name, target }).includes(
            JSON.stringify(value).slice(1, -1),
          )
        )
          throw new Error(
            "Credentials cannot appear in public external agent configuration.",
          );
      }
      const record = { id: existing?.id ?? randomUUID(), name, target };
      file.records = file.records.filter((item) => item.id !== record.id);
      file.records.push(record);
      file.pendingDeletes = file.pendingDeletes.filter(
        (item) => item !== reference,
      );
      if (
        previous?.reference &&
        previous.reference !== (binding.required ? reference : undefined)
      )
        file.pendingDeletes.push(previous.reference);
      await writePrivateJson(this.filename, file);
      await this.cleanup(file);
      return this.public(record);
    });
  }
  delete(id: string): Promise<void> {
    return this.serialize(async () => {
      const file = await this.read();
      await this.cleanup(file);
      const record = file.records.find((item) => item.id === id);
      if (!record) throw new Error("The external agent does not exist.");
      const reference = this.binding(
        record.target as ExternalTargetConfig,
      ).reference;
      file.records = file.records.filter((item) => item.id !== id);
      if (reference) file.pendingDeletes.push(reference);
      await writePrivateJson(this.filename, file);
      await this.cleanup(file);
    });
  }
}
