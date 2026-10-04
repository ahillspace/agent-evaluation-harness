import { describe, expect, it } from "vitest";
import { inspectSource } from "../scripts/architecture-check.mjs";

describe("enforced ownership boundaries", () => {
  it("allows presentation to consume shared contracts", () => {
    expect(
      inspectSource(
        "src/web/setup.tsx",
        "import type { AgentConfig } from '../contracts.js';",
      ),
    ).toEqual([]);
  });

  it("rejects presentation that reaches storage through any import form", () => {
    for (const source of [
      "import { Store } from '../storage/store.js';",
      "export { Store } from '../storage/store.js';",
      "await import('../storage/store.js');",
      "require('../storage/store.js');",
    ])
      expect(inspectSource("src/web/setup.tsx", source)).toContainEqual(
        expect.stringContaining("web cannot import storage"),
      );
  });

  it("keeps concrete runtime implementations outside application services", () => {
    expect(
      inspectSource(
        "src/application/runs.ts",
        "import { Runtime } from '../runtime/index.js';",
      ),
    ).toContainEqual(
      expect.stringContaining("application cannot import runtime"),
    );
  });

  it("rejects an unclassified module or a dependency on the previous repository", () => {
    expect(
      inspectSource("src/helpers.ts", "export const n = 1;"),
    ).toContainEqual(expect.stringContaining("Unclassified production module"));
    expect(
      inspectSource(
        "src/domain/rules.ts",
        "import { Old } from '@tableau-autoresearch/contracts';",
      ),
    ).toContainEqual(expect.stringContaining("previous repository"));
    expect(
      inspectSource(
        "src/domain/rules.ts",
        "import '../../../../../outside.js';",
      ),
    ).toContainEqual(expect.stringContaining("outside src"));
  });

  it("prevents Node APIs and unreviewable dynamic imports in presentation", () => {
    expect(
      inspectSource("src/web/setup.tsx", "import fs from 'node:fs';"),
    ).toContainEqual(expect.stringContaining("Node APIs"));
    expect(
      inspectSource("src/web/setup.tsx", "await import(moduleName);"),
    ).toContainEqual(expect.stringContaining("computed import"));
  });

  it("allows the composition root to wire concrete implementations", () => {
    expect(
      inspectSource(
        "src/server.ts",
        "import { Runtime } from './runtime/index.js'; import { Application } from './application/index.js';",
      ),
    ).toEqual([]);
  });

  it("keeps credential storage independent of process ownership", () => {
    expect(
      inspectSource(
        "src/runtime/secrets/keychain.ts",
        "import { ProcessSupervisor } from '../process-supervisor.js';",
      ),
    ).toContainEqual(expect.stringContaining("Credential infrastructure"));
    expect(
      inspectSource(
        "src/runtime/processes/windows.ts",
        "import { SecretStore } from '../secrets/store.js';",
      ),
    ).toContainEqual(expect.stringContaining("Process infrastructure"));
    expect(
      inspectSource(
        "src/runtime/connections.ts",
        "import { Driver } from './processes/windows.js';",
      ),
    ).toContainEqual(expect.stringContaining("Connection services"));
  });

  it("confines concrete platform wiring to runtime composition", () => {
    expect(
      inspectSource(
        "src/runtime/harness.ts",
        "import { WindowsProcessDriver } from './processes/windows.js';",
      ),
    ).toContainEqual(expect.stringContaining("Platform implementations"));
    expect(
      inspectSource(
        "src/runtime/process-supervisor.ts",
        "import { KeychainSecretStore } from './secrets/keychain.js';",
      ),
    ).toContainEqual(expect.stringContaining("shared coordinator"));
    expect(
      inspectSource(
        "src/runtime/platform.ts",
        "import { WindowsProcessDriver } from './processes/windows.js'; import { KeychainSecretStore } from './secrets/keychain.js';",
      ),
    ).toEqual([]);
  });

  it("rejects operating system decisions in provider and shared service code", () => {
    for (const source of [
      "if (process.platform === 'win32') run();",
      "if (process['platform'] === 'darwin') run();",
      "import { platform as os } from 'node:os';",
    ]) {
      expect(inspectSource("src/runtime/harness.ts", source)).toContainEqual(
        expect.stringContaining("Operating system selection"),
      );
    }
    expect(
      inspectSource(
        "src/runtime/commands.ts",
        "if (process.platform === 'win32') resolveLauncher();",
      ),
    ).toEqual([]);
    expect(
      inspectSource(
        "src/runtime/platform.ts",
        "if (process.platform === 'darwin') createDriver();",
      ),
    ).toEqual([]);
  });
});
