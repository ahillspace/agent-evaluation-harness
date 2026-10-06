import { z } from "zod";
import type { Json } from "../contracts.js";

export const MODEL_PROVIDERS = [
  "openai",
  "anthropic",
  "openrouter",
  "amazon-bedrock",
] as const;
const endpoint = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, "Use HTTPS (or loopback HTTP) without credentials, query parameters, or fragments.");
const httpSettings = z
  .object({
    baseUrl: endpoint.optional(),
    authMode: z.enum(["api-key", "bearer"]).default("api-key"),
  })
  .strict();
const bedrockSettings = z
  .object({
    baseUrl: endpoint.optional(),
    authMode: z.literal("bearer").default("bearer"),
    region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d+$/),
  })
  .strict();
export function modelProviderSettings(
  provider: string,
  settings: Record<string, Json>,
): Record<string, Json> {
  if (!MODEL_PROVIDERS.some((value) => value === provider))
    throw new Error(`Unsupported model provider: ${provider}.`);
  return (provider === "amazon-bedrock" ? bedrockSettings : httpSettings).parse(
    settings,
  );
}
const keys: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  "amazon-bedrock": "AWS_BEARER_TOKEN_BEDROCK",
};
export function providerEnvironment(
  provider: string,
  settings: Record<string, Json>,
  secret: string,
): Record<string, string> {
  const validated = modelProviderSettings(provider, settings);
  const key =
    provider === "anthropic" && validated.authMode === "bearer"
      ? "ANTHROPIC_AUTH_TOKEN"
      : keys[provider]!;
  return {
    [key]: secret,
    ...(typeof validated.baseUrl === "string"
      ? {
          [`${provider.toUpperCase().replaceAll("-", "_")}_BASE_URL`]:
            validated.baseUrl,
        }
      : {}),
    ...(provider === "amazon-bedrock"
      ? { AWS_REGION: String(validated.region) }
      : {}),
  };
}
export function openCodeProvider(
  model: string,
  env: Record<string, string>,
): Record<string, unknown> {
  const provider = model.split("/")[0]!;
  const key =
    provider === "anthropic" && env.ANTHROPIC_AUTH_TOKEN
      ? "ANTHROPIC_AUTH_TOKEN"
      : keys[provider];
  if (!key || !env[key]) return {};
  const baseUrl =
    env[`${provider.toUpperCase().replaceAll("-", "_")}_BASE_URL`];
  return {
    [provider]: {
      options: {
        [key === "ANTHROPIC_AUTH_TOKEN" ? "authToken" : "apiKey"]:
          `{env:${key}}`,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
        ...(provider === "amazon-bedrock" ? { region: env.AWS_REGION } : {}),
      },
    },
  };
}
export function providerProbe(
  provider: string,
  settings: Record<string, Json>,
  secret: string,
): { url: string; headers: Record<string, string> } | undefined {
  const validated = modelProviderSettings(provider, settings);
  // Bedrock Converse has no models route; a model invocation would incur usage.
  if (provider === "amazon-bedrock") return undefined;
  const defaults: Record<string, string> = {
    openai: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com/v1",
    openrouter: "https://openrouter.ai/api/v1",
  };
  return {
    url: `${String(validated.baseUrl ?? defaults[provider]).replace(/\/$/, "")}/models`,
    headers: {
      ...(provider === "anthropic" && validated.authMode !== "bearer"
        ? { "x-api-key": secret }
        : { authorization: `Bearer ${secret}` }),
      ...(provider === "anthropic"
        ? { "anthropic-version": "2023-06-01" }
        : {}),
    },
  };
}
