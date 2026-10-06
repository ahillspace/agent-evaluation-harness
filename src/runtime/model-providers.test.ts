import { expect, it } from "vitest";
import {
  modelProviderSettings,
  providerEnvironment,
  openCodeProvider,
  providerProbe,
} from "./model-providers.js";

it("separates Anthropic bearer tokens from API key headers", () => {
  const settings = modelProviderSettings("anthropic", {
    authMode: "bearer",
    baseUrl: "https://gateway.example/v1",
  });
  const env = providerEnvironment("anthropic", settings, "secret");
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe("secret");
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(providerProbe("anthropic", settings, "secret")?.headers).toEqual({
    authorization: "Bearer secret",
    "anthropic-version": "2023-06-01",
  });
  expect(openCodeProvider("anthropic/model", env)).toMatchObject({
    anthropic: {
      options: {
        authToken: "{env:ANTHROPIC_AUTH_TOKEN}",
        baseURL: "https://gateway.example/v1",
      },
    },
  });
});
it("configures Bedrock Converse independently of Anthropic Messages", () => {
  const settings = modelProviderSettings("amazon-bedrock", {
    region: "us-west-2",
    baseUrl: "https://bedrock.example",
  });
  const env = providerEnvironment("amazon-bedrock", settings, "secret");
  expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe("secret");
  expect(openCodeProvider("amazon-bedrock/model", env)).toMatchObject({
    "amazon-bedrock": {
      options: {
        region: "us-west-2",
        baseURL: "https://bedrock.example",
        apiKey: "{env:AWS_BEARER_TOKEN_BEDROCK}",
      },
    },
  });
  expect(providerProbe("amazon-bedrock", settings, "secret")).toBeUndefined();
});
it("rejects unsupported authentication and credential-bearing URLs", () => {
  expect(() =>
    modelProviderSettings("anthropic", {
      baseUrl: "http://gateway.example/v1",
    }),
  ).toThrow();
  expect(() =>
    modelProviderSettings("anthropic", { baseUrl: "http://127.0.0.1:9876/v1" }),
  ).not.toThrow();
  expect(() =>
    modelProviderSettings("amazon-bedrock", {
      authMode: "api-key",
      region: "us-east-1",
    }),
  ).toThrow();
  expect(() =>
    modelProviderSettings("openai", {
      baseUrl: "https://user:pass@example.com",
    }),
  ).toThrow();
  expect(() =>
    modelProviderSettings("anthropic", { authMode: "subscription" }),
  ).toThrow();
});
