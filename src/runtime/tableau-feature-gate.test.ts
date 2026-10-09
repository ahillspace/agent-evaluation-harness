import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
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

it("overlays arbitrary feature names while preserving defaults and environment values", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aeh-feature-fixture-"));
  const prepared = await prepareTableauFeatureGate(
    { futureFeature: true, defaultEnabled: false },
    { Future_option: "literal value" },
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
