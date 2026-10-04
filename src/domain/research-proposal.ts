import {
  agentSchema,
  type AgentConfig,
  type ResearchInput,
} from "../contracts.js";
import { AppError } from "./errors.js";
import { digest } from "./identity.js";

export function validateResearchProposal(
  configuration: ResearchInput,
  baseline: AgentConfig,
  proposal: AgentConfig,
): AgentConfig {
  const parsed = agentSchema.parse(proposal);
  const fields = new Set<string>(configuration.allowedChanges);
  for (const field of [
    "harness",
    "model",
    "systemPrompt",
    "settings",
    "tools",
    "connections",
  ] as const) {
    if (!fields.has(field) && digest(parsed[field]) !== digest(baseline[field]))
      throw new AppError(
        "mutation_not_allowed",
        `The researcher changed ${field}, which is outside the allowed mutation space.`,
      );
  }
  const space = configuration.searchSpace;
  if (space?.models && !space.models.includes(parsed.model))
    throw new AppError(
      "mutation_not_allowed",
      "The proposed model is outside the allowed search space.",
    );
  if (space?.tools && parsed.tools.some((tool) => !space.tools!.includes(tool)))
    throw new AppError(
      "mutation_not_allowed",
      "The proposed tools are outside the allowed search space.",
    );
  if (
    space?.maxSystemPromptLength &&
    parsed.systemPrompt.length > space.maxSystemPromptLength
  )
    throw new AppError(
      "mutation_not_allowed",
      "The proposed system prompt exceeds its search space limit.",
    );
  if (space?.settings) {
    for (const key of new Set([
      ...Object.keys(baseline.settings),
      ...Object.keys(parsed.settings),
    ])) {
      if (digest(parsed.settings[key]) === digest(baseline.settings[key]))
        continue;
      if (
        !space.settings[key]?.some(
          (value) => digest(value) === digest(parsed.settings[key]),
        )
      )
        throw new AppError(
          "mutation_not_allowed",
          `The proposed ${key} setting is outside the allowed search space.`,
        );
    }
  }
  return parsed;
}
