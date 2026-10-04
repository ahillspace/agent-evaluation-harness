import type {
  AgentConfig,
  TargetConfig,
  TargetOutput,
} from "../../contracts.js";
import { managedAgent, managedCapabilities } from "../../contracts/targets.js";
import type {
  TargetAdapter,
  TargetAdapterOutput,
  TargetInvocation,
} from "./contracts.js";

export class ManagedTargetAdapter implements TargetAdapter {
  readonly id = "managed";
  readonly version = 1;
  readonly capabilities = managedCapabilities;
  validate(target: TargetConfig): TargetConfig {
    managedAgent(target);
    return target;
  }
  constructor(
    private readonly resolveAgent: (agent: AgentConfig) => Promise<AgentConfig>,
    private readonly execute: (
      input: TargetInvocation & { agent: AgentConfig },
    ) => Promise<TargetOutput>,
  ) {}
  async resolve(target: TargetConfig): Promise<TargetConfig> {
    return {
      kind: "managed",
      agent: await this.resolveAgent(managedAgent(target)),
    };
  }
  async invoke(input: TargetInvocation): Promise<TargetAdapterOutput> {
    const output = await this.execute({
      ...input,
      agent: managedAgent(input.target),
    });
    return {
      ...output,
      cleanup: output.cleanup ?? "complete",
      evidenceScope: "internal-activity",
    };
  }
  async recover() {
    return {
      cleanup: "complete" as const,
      remoteCompletion: "not-dispatched" as const,
    };
  }
  async close() {}
}
