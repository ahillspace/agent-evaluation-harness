import type {
  AgentConfig,
  TargetCapabilities,
  TargetConfig,
} from "../contracts.js";

/** Reads old immutable records without rewriting their bytes or digest. */
export function savedTarget(value: {
  target?: TargetConfig;
  agent?: AgentConfig;
}): TargetConfig {
  if (value.target) return value.target;
  if (value.agent) return { kind: "managed", agent: value.agent };
  throw new Error("The saved record has no target configuration.");
}
export function managedAgent(target: TargetConfig): AgentConfig {
  if (target.kind !== "managed")
    throw new Error("This operation requires a managed agent.");
  return target.agent;
}
export function targetLabel(target: TargetConfig): string {
  return target.kind === "managed"
    ? `${target.agent.harness} / ${target.agent.model}`
    : target.name;
}
export const managedCapabilities: TargetCapabilities = {
  configurationOwnership: "managed",
  observation: "internal-activity",
  cancellation: "owned-processes",
  research: true,
  exportScope: "agent",
};
export const externalCapabilities: TargetCapabilities = {
  configurationOwnership: "external",
  observation: "answer-only",
  cancellation: "unconfirmed-remote",
  research: false,
  exportScope: "endpoint",
};

/** Persistence can reorder object keys without changing a frozen configuration. */
export function sameTarget(
  left: TargetConfig | undefined,
  right: TargetConfig | undefined,
): boolean {
  const canonical = (target: TargetConfig | undefined) =>
    JSON.stringify(target, (_key, value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0,
            ),
          )
        : value,
    );
  return canonical(left) === canonical(right);
}
