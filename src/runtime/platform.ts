import { ProcessSupervisor } from "./process-supervisor.js";
import { WindowsProcessDriver } from "./processes/windows.js";
import { PosixProcessDriver } from "./processes/posix.js";
import type { ProcessDriver } from "./processes/contracts.js";
import type { SecretStore } from "./secrets/store.js";
import {
  createWindowsSecretStore,
  decryptWindowsCredential,
} from "./secrets/windows.js";
import { createMacSecretStore } from "./secrets/keychain.js";
import { migrateConnections } from "./connection-migration.js";

function unsupported(): never {
  throw new Error("Live runtime execution supports Windows and macOS.");
}
function processDriver(directory: string): ProcessDriver {
  switch (process.platform) {
    case "win32":
      return new WindowsProcessDriver(directory);
    case "darwin":
      return new PosixProcessDriver(directory);
    default:
      return {
        capabilities: { hardDescendantLimit: false },
        recover: async () => unsupported(),
        prepare: async () => unsupported(),
        launch: async () => unsupported(),
        cleanup: async () => unsupported(),
      };
  }
}
export function createProcessSupervisor(options: {
  stateDirectory: string;
  maxConcurrentInvocations?: number;
}) {
  return new ProcessSupervisor({
    driver: processDriver(options.stateDirectory),
    maxConcurrentInvocations: options.maxConcurrentInvocations,
  });
}
export interface PlatformServices {
  supervisor: ProcessSupervisor;
  secrets: SecretStore;
  initialize(): Promise<void>;
}
export function createPlatformServices(options: {
  stateDirectory: string;
  maxConcurrentInvocations?: number;
}): PlatformServices {
  const supervisor = createProcessSupervisor(options);
  let secrets: SecretStore;
  switch (process.platform) {
    case "win32":
      secrets = createWindowsSecretStore(options.stateDirectory);
      break;
    case "darwin":
      secrets = createMacSecretStore(options.stateDirectory);
      break;
    default:
      secrets = {
        allocate: async () => unsupported(),
        owns: async () => unsupported(),
        read: async () => unsupported(),
        write: async () => unsupported(),
        delete: async () => unsupported(),
      };
  }
  return {
    supervisor,
    secrets,
    initialize: () =>
      migrateConnections(
        options.stateDirectory,
        secrets,
        process.platform === "win32" ? decryptWindowsCredential : undefined,
      ),
  };
}
