import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const providerSource = `const fs = require("node:fs");
const path = require("node:path");

class FeatureGateProvider {
  constructor() {
    const entry = process.argv[1];
    let defaults;
    try {
      const realEntry = fs.realpathSync(entry);
      defaults = JSON.parse(fs.readFileSync(path.join(path.dirname(realEntry), "features.json"), "utf8"));
      if (!defaults || typeof defaults !== "object" || Array.isArray(defaults) ||
          Object.values(defaults).some(value => typeof value !== "boolean")) throw new Error();
    } catch {
      throw new Error("Tableau MCP feature defaults could not be loaded from the server entry point.");
    }
    let overrides = {};
    try {
      overrides = JSON.parse(process.env.AEH_TABLEAU_FEATURE_OVERRIDES || "{}");
    } catch {}
    this.features = { ...defaults, ...overrides };
  }

  async isFeatureEnabled(name) {
    return this.features[name] === true;
  }
}

module.exports = { default: FeatureGateProvider };
`;

export async function prepareTableauFeatureGate(
  features: Record<string, boolean>,
  env: Record<string, string>,
  ownerDirectory?: string,
): Promise<{
  env: Record<string, string>;
  cleanup: () => Promise<void>;
}> {
  if (!Object.keys(features).length)
    return { env, cleanup: async () => undefined };

  if (!ownerDirectory)
    throw new Error(
      "Tableau feature overrides require a parent-owned resource directory.",
    );
  const directory = await mkdtemp(
    path.join(ownerDirectory, "tableau-features-"),
  );
  const modulePath = path.join(directory, "feature-gate-provider.cjs");
  try {
    await writeFile(modulePath, providerSource, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    env: {
      ...env,
      FEATURE_GATE_PROVIDER: "custom",
      FEATURE_GATE_PROVIDER_CONFIG: JSON.stringify({ module: modulePath }),
      AEH_TABLEAU_FEATURE_OVERRIDES: JSON.stringify(features),
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
