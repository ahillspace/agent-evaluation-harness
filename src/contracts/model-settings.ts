import { z } from "zod";

export const settingsSchema = z
  .object({
    authSource: z.enum(["local", "connection"]).optional(),
    maxTurns: z.number().int().min(1).max(500).default(40),
    reasoningEffort: z
      .enum([
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ])
      .optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict();

export function validateModelSettings(harness: string, value: unknown) {
  const settings = settingsSchema.parse(value);
  if (
    harness === "bedrock" &&
    settings.temperature !== undefined &&
    settings.temperature > 1
  )
    throw new Error("Bedrock Converse temperature must be from 0 to 1.");
  if (harness === "bedrock" && settings.reasoningEffort !== undefined)
    throw new Error(
      "Bedrock Converse does not expose reasoningEffort in this adapter.",
    );
  if (
    (harness === "codex" || harness === "claude") &&
    (settings.temperature !== undefined ||
      settings.maxOutputTokens !== undefined)
  )
    throw new Error(
      `${harness} does not support temperature or maxOutputTokens in this adapter.`,
    );
  if (
    harness === "claude" &&
    settings.reasoningEffort &&
    !["low", "medium", "high", "xhigh", "max"].includes(
      settings.reasoningEffort,
    )
  )
    throw new Error(
      "Claude reasoningEffort must be low, medium, high, xhigh, or max.",
    );
  return settings;
}
