import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { prepareTableauFeatureGate } from "./tableau-feature-gate.js";

it("preserves arbitrary environment values when no feature override is configured", async () => {
  const env = {
    Future_option: "literal value",
    FEATURE_GATE_PROVIDER: "custom",
  };
  const prepared = await prepareTableauFeatureGate({}, env);
  expect(prepared.env).toEqual(env);
  await prepared.cleanup();
});

it("rejects missing package defaults instead of silently disabling default features", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aeh-feature-missing-"));
  const prepared = await prepareTableauFeatureGate(
    { futureFeature: true },
    {},
    directory,
  );
  try {
    const entry = path.join(directory, "server.cjs");
    await writeFile(
      entry,
      `const Provider = require(JSON.parse(process.env.FEATURE_GATE_PROVIDER_CONFIG).module).default; new Provider();`,
    );
    await expect(
      promisify(execFile)(process.execPath, [entry], {
        env: { ...process.env, ...prepared.env },
        timeout: 10_000,
      }),
    ).rejects.toThrow("Tableau MCP feature defaults could not be loaded");
  } finally {
    await prepared.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")(
  "loads defaults beside the real entry point when launched through a bin symlink",
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "aeh-feature-symlink-"),
    );
    const prepared = await prepareTableauFeatureGate(
      { "knowledge-tools": true },
      {},
      directory,
    );
    try {
      const build = path.join(directory, "build");
      const bin = path.join(directory, "bin");
      await mkdir(build);
      await mkdir(bin);
      await writeFile(
        path.join(build, "features.json"),
        JSON.stringify({ "authoring-tools": true, "workbook-file-mode": true }),
      );
      const entry = path.join(build, "index.cjs");
      await writeFile(
        entry,
        `process.argv[1] = ${JSON.stringify(path.join(bin, "tableau-mcp"))}; const Provider = require(JSON.parse(process.env.FEATURE_GATE_PROVIDER_CONFIG).module).default; const provider = new Provider(); Promise.all(["authoring-tools", "workbook-file-mode", "knowledge-tools"].map(name => provider.isFeatureEnabled(name))).then(values => console.log(JSON.stringify(values)));`,
      );
      await symlink(entry, path.join(bin, "tableau-mcp"));
      const result = await promisify(execFile)(
        process.execPath,
        [path.join(bin, "tableau-mcp")],
        { env: { ...process.env, ...prepared.env }, timeout: 10_000 },
      );
      expect(JSON.parse(result.stdout)).toEqual([true, true, true]);
    } finally {
      await prepared.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("overlays arbitrary feature names while preserving defaults and environment values", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aeh-feature-fixture-"));
  const prepared = await prepareTableauFeatureGate(
    { futureFeature: true, defaultEnabled: false },
    { Future_option: "literal value" },
    directory,
  );
  const modulePath = JSON.parse(
    prepared.env.FEATURE_GATE_PROVIDER_CONFIG!,
  ).module;
  try {
    await writeFile(
      path.join(directory, "features.json"),
      JSON.stringify({ defaultEnabled: true, untouchedDefault: true }),
    );
    const script = path.join(directory, "server.cjs");
    await writeFile(
      script,
      `
      const Provider = require(JSON.parse(process.env.FEATURE_GATE_PROVIDER_CONFIG).module).default;
      const provider = new Provider();
      Promise.all(['futureFeature', 'defaultEnabled', 'untouchedDefault', 'unknown'].map(name => provider.isFeatureEnabled(name)))
        .then(values => process.stdout.write(JSON.stringify({ values, env: process.env.Future_option })));
    `,
    );
    const result = await promisify(execFile)(process.execPath, [script], {
      env: { ...process.env, ...prepared.env },
      timeout: 10_000,
      windowsHide: true,
    });
    expect(JSON.parse(result.stdout)).toEqual({
      values: [true, false, true, false],
      env: "literal value",
    });
  } finally {
    await prepared.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
  await expect(access(modulePath)).rejects.toMatchObject({ code: "ENOENT" });
});
