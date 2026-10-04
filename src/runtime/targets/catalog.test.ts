import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ExternalTargetConfig } from "../../contracts.js";
import { httpTargetSchema } from "../../contracts/http-target.js";
import type { SecretStore } from "../secrets/store.js";
import { ExternalTargetCatalog } from "./catalog.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "aeh-external-catalog-"));
  directories.push(directory);
  const values = new Map<string, string>();
  let sequence = 0;
  const secrets: SecretStore = {
    allocate: async () => `reference-${++sequence}`,
    owns: async (reference) => values.has(reference),
    read: async (reference) => {
      const value = values.get(reference);
      if (value === undefined) throw new Error("Missing secret");
      return value;
    },
    write: async (reference, value) => {
      values.set(reference, value);
    },
    delete: async (reference) => {
      values.delete(reference);
    },
  };
  const validate = (target: ExternalTargetConfig): ExternalTargetConfig => ({
    ...target,
    configuration: httpTargetSchema.parse(target.configuration),
  });
  const binding = (target: ExternalTargetConfig) => {
    const configuration = httpTargetSchema.parse(target.configuration);
    return {
      required: configuration.authentication.kind !== "none",
      reference:
        configuration.authentication.kind === "none"
          ? undefined
          : configuration.authentication.credentialReference,
      bind: (reference: string | undefined): ExternalTargetConfig => ({
        ...target,
        configuration: {
          ...configuration,
          authentication:
            configuration.authentication.kind === "none"
              ? { kind: "none" }
              : {
                  ...configuration.authentication,
                  credentialReference: reference ?? "unbound",
                },
        },
      }),
    };
  };
  const catalog = new ExternalTargetCatalog(
    directory,
    secrets,
    validate,
    binding,
  );
  return { directory, secrets, values, catalog, validate, binding };
}
const target: ExternalTargetConfig = {
  kind: "external",
  name: "Endpoint",
  adapterId: "http",
  adapterVersion: 1,
  configuration: httpTargetSchema.parse({
    endpoint: "https://example.com",
    authentication: { kind: "bearer", credentialReference: "unbound" },
  }),
};
it("saves opaque credentials and freezes resolved configurations", async () => {
  const { catalog, directory } = await setup();
  const saved = await catalog.save({
    name: "Endpoint",
    target,
    credential: "secret-one",
  });
  const frozen = await catalog.resolve(saved.target);
  expect(saved.hasCredentials).toBe(true);
  expect(await catalog.credential(frozen)).toBe("secret-one");
  expect(
    await readFile(path.join(directory, "external-targets.json"), "utf8"),
  ).not.toContain("secret-one");
  await catalog.save({
    id: saved.id,
    name: "Changed",
    target: {
      ...saved.target,
      configuration: {
        ...httpTargetSchema.parse(saved.target.configuration),
        endpoint: "https://other.example.com",
      },
    },
    credential: "secret-two",
  });
  expect(httpTargetSchema.parse(frozen.configuration).endpoint).toBe(
    "https://example.com",
  );
});
it("rejects changed endpoint credential reuse until explicitly rebound", async () => {
  const { catalog } = await setup();
  const saved = await catalog.save({
    name: "Endpoint",
    target,
    credential: "secret-one",
  });
  await expect(
    catalog.save({
      id: saved.id,
      name: "Changed",
      target: {
        ...saved.target,
        configuration: {
          ...httpTargetSchema.parse(saved.target.configuration),
          endpoint: "https://other.example.com",
        },
      },
    }),
  ).rejects.toThrow();
});
it("cleans failed replacement intents without damaging the active credential", async () => {
  const { catalog, secrets, values } = await setup();
  const saved = await catalog.save({
    name: "Endpoint",
    target,
    credential: "secret-one",
  });
  secrets.write = async () => {
    throw new Error("Storage unavailable");
  };
  await expect(
    catalog.save({
      id: saved.id,
      name: "Endpoint",
      target: saved.target,
      credential: "secret-two",
    }),
  ).rejects.toThrow();
  await catalog.recover();
  expect(await catalog.credential(saved.target)).toBe("secret-one");
  expect(values.size).toBe(1);
});
it("does not resolve or delete credentials owned by another workspace", async () => {
  const { catalog, secrets, values } = await setup();
  const saved = await catalog.save({
    name: "Endpoint",
    target,
    credential: "secret-one",
  });
  secrets.owns = async () => false;
  expect((await catalog.list())[0]!.hasCredentials).toBe(false);
  await expect(catalog.resolve(saved.target)).rejects.toThrow();
  await catalog.delete(saved.id);
  expect(values.size).toBe(1);
});
it("rejects a saved credential redirected through a modified launch payload", async () => {
  const { catalog } = await setup();
  const saved = await catalog.save({
    name: "Endpoint",
    target,
    credential: "secret-one",
  });
  await expect(
    catalog.credential({
      ...saved.target,
      configuration: {
        ...httpTargetSchema.parse(saved.target.configuration),
        endpoint: "https://attacker.example.com",
      },
    }),
  ).rejects.toThrow();
});
it("keeps a credential while another saved target references it", async () => {
  const { catalog } = await setup();
  const first = await catalog.save({
    name: "First",
    target,
    credential: "secret-one",
  });
  const second = await catalog.save({ name: "Second", target: first.target });
  await catalog.delete(first.id);
  expect(await catalog.credential(second.target)).toBe("secret-one");
});
it("rejects exposing the existing credential in a display name", async () => {
  const { catalog } = await setup();
  const saved = await catalog.save({
    name: "Endpoint",
    target,
    credential: "secret-one",
  });
  await expect(
    catalog.save({ id: saved.id, name: "secret-one", target: saved.target }),
  ).rejects.toThrow();
});

it("retains frozen credential versions through replacement, deletion, and restart", async () => {
  const { catalog, directory, secrets, validate, binding, values } =
    await setup();
  const first = await catalog.save({
    name: "Endpoint",
    target,
    credential: "secret-one",
  });
  await catalog.retain(first.target);
  const replacement = await catalog.save({
    id: first.id,
    name: "Endpoint",
    target: first.target,
    credential: "secret-two",
  });
  expect(await catalog.credential(first.target)).toBe("secret-one");
  expect(await catalog.credential(replacement.target)).toBe("secret-two");
  await catalog.delete(first.id);
  expect(values.size).toBe(1);
  const restarted = new ExternalTargetCatalog(
    directory,
    secrets,
    validate,
    binding,
  );
  await restarted.recover();
  expect(await restarted.credential(first.target)).toBe("secret-one");
  expect(await restarted.list()).toEqual([]);
});

it("upgrades version-one catalog data without changing existing credentials", async () => {
  const { catalog, directory } = await setup();
  const saved = await catalog.save({
    name: "Endpoint",
    target,
    credential: "secret-one",
  });
  const file = JSON.parse(
    await readFile(path.join(directory, "external-targets.json"), "utf8"),
  );
  delete file.retainedReferences;
  file.version = 1;
  await writeFile(
    path.join(directory, "external-targets.json"),
    JSON.stringify(file),
  );
  await catalog.retain(saved.target);
  const upgraded = JSON.parse(
    await readFile(path.join(directory, "external-targets.json"), "utf8"),
  );
  expect(upgraded.version).toBe(2);
  expect(upgraded.retainedReferences).toHaveLength(1);
  expect(await catalog.credential(saved.target)).toBe("secret-one");
});
