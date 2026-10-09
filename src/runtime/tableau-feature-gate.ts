import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const providerSource = `const fs = require("node:fs");
const path = require("node:path");

class FeatureGateProvider {
  constructor() {
    const entry = process.argv[1];
    let defaults = {};
    if (entry) {
      try {
        defaults = JSON.parse(
          fs.readFileSync(path.join(path.dirname(path.resolve(entry)), "features.json"), "utf8"),
        );
      } catch {}
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
): Promise<{
  env: Record<string, string>;
  cleanup: () => Promise<void>;
}> {
  if (!Object.keys(features).length)
    return { env, cleanup: async () => undefined };

  const directory = await mkdtemp(path.join(tmpdir(), "aeh-tableau-features-"));
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
