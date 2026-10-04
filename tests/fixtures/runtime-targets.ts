import type { RuntimePort } from "../../src/contracts.js";
import {
  managedCapabilities,
  externalCapabilities,
} from "../../src/contracts/targets.js";

export const targetFixture: Pick<
  RuntimePort,
  "resolveTarget" | "recoverTarget" | "previewTarget" | "externalTargets"
> = {
  async resolveTarget(target) {
    return {
      target:
        target.kind === "managed"
          ? {
              ...target,
              agent: await (this as RuntimePort).resolveAgent(target.agent),
            }
          : target,
      capabilities:
        target.kind === "managed" ? managedCapabilities : externalCapabilities,
    };
  },
  recoverTarget: async () => ({
    cleanup: "complete",
    remoteCompletion: "unknown",
  }),
  previewTarget: async () => {
    throw new Error("Unused preview");
  },
  externalTargets: {
    retain: async () => {},
    list: async () => [],
    save: async () => {
      throw new Error("Unused catalog");
    },
    delete: async () => {},
  },
};
