import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RoleProvider, ModelFields } from "./model-fields.js";
import { modelSettingsGuide } from "./json-guides.js";
import { validateModelSettings } from "../contracts/model-settings.js";
import type { ConnectionRecord } from "../contracts.js";

const connections: ConnectionRecord[] = [
  {
    id: "a",
    name: "Anthropic token",
    provider: "anthropic",
    settings: { authMode: "bearer" },
    credentialFields: ["apiKey"],
    hasCredentials: true,
  },
  {
    id: "b",
    name: "Company gateway",
    provider: "amazon-bedrock",
    settings: { authMode: "bearer", region: "us-west-2" },
    credentialFields: ["apiKey"],
    hasCredentials: true,
  },
];

it("separates subscription authentication from compatible saved API credentials", () => {
  const html = renderToStaticMarkup(
    <RoleProvider
      label="Authentication"
      harness="claude"
      connections={connections}
      value=""
      onChange={() => {}}
    />,
  );
  expect(html).toContain("Subscription / local harness account");
  expect(html).toContain("Anthropic token");
  expect(html).not.toContain("Company gateway");
});
it("keeps unavailable credentials visible and never offers a subscription for direct Bedrock", () => {
  const html = renderToStaticMarkup(
    <RoleProvider
      label="Authentication"
      harness="bedrock"
      connections={connections}
      value="missing"
      onChange={() => {}}
    />,
  );
  expect(html).toContain("unavailable or incompatible");
  expect(html).toContain("Company gateway");
  expect(html).not.toContain("Subscription / local harness account");
});
it("lists supported harnesses before installation discovery", () => {
  const html = renderToStaticMarkup(
    <ModelFields
      harness="codex"
      model=""
      onHarness={() => {}}
      onModel={() => {}}
    />,
  );
  for (const label of [
    "OpenAI Codex",
    "Anthropic Claude Code",
    "OpenCode",
    "Amazon Bedrock Converse",
  ])
    expect(html).toContain(label);
});
it("all displayed model-setting examples satisfy the runtime contract", () => {
  for (const harness of ["codex", "claude", "opencode", "bedrock"])
    expect(() =>
      validateModelSettings(harness, modelSettingsGuide(harness).example),
    ).not.toThrow();
});
