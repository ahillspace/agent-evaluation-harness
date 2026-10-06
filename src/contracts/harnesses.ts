export const HARNESS_LABELS = {
  codex: "OpenAI Codex",
  claude: "Anthropic Claude Code",
  opencode: "OpenCode",
  bedrock: "Amazon Bedrock Converse",
} as const;
export function supportsProvider(harness: string, provider: string): boolean {
  if (harness === "codex") return provider === "openai";
  if (harness === "claude") return provider === "anthropic";
  if (harness === "bedrock") return provider === "amazon-bedrock";
  return (
    harness === "opencode" &&
    ["openai", "anthropic", "openrouter", "amazon-bedrock"].includes(provider)
  );
}
