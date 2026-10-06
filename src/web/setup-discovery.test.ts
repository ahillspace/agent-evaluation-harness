import { describe, expect, it } from "vitest";
import { credentialModels } from "./setup-discovery.js";

describe("credential-specific model discovery", () => {
  it("uses provider-prefixed IDs only for OpenCode and retains display names", () => {
    const resources = {
      models: [{ id: "anthropic/claude-test", name: "Claude test" }],
    };
    expect(credentialModels(resources, "opencode", "openrouter")).toEqual([
      {
        id: "openrouter/anthropic/claude-test",
        name: "Claude test",
        provider: "openrouter",
      },
    ]);
    expect(credentialModels(resources, "codex", "openrouter")[0]?.id).toBe(
      "anthropic/claude-test",
    );
    expect(
      credentialModels(
        { models: [{ id: "openrouter/test" }] },
        "opencode",
        "openrouter",
      )[0]?.id,
    ).toBe("openrouter/test");
  });
  it("keeps unavailable or malformed catalogs empty without inventing model IDs", () => {
    expect(credentialModels(undefined, "claude", "anthropic")).toEqual([]);
    expect(
      credentialModels(
        { models: [null, { name: "missing ID" }, 5] },
        "codex",
        "openai",
      ),
    ).toEqual([]);
  });
});
