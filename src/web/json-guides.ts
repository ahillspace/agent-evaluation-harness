import type { JsonGuide } from "./json-editor.js";

export function modelSettingsGuide(harness: string): JsonGuide {
  return {
    description:
      "Optional settings for this agent. Use {} for defaults. Authentication is selected separately. Model capabilities can restrict these options further.",
    example:
      harness === "bedrock"
        ? { maxTurns: 40, maxOutputTokens: 4096 }
        : { maxTurns: 40, reasoningEffort: "medium" },
    fields: [
      {
        key: "maxTurns",
        description:
          "Maximum agent steps within one question, not the number of questions.",
        values: "integer from 1 to 500",
        default: "40",
      },
      ...(harness === "bedrock"
        ? []
        : [
            {
              key: "reasoningEffort",
              description:
                "How much reasoning to request from a model that supports it.",
              values:
                harness === "claude"
                  ? "low, medium, high, xhigh, max"
                  : "none, minimal, low, medium, high, xhigh, max, ultra",
              default: "provider default",
            },
          ]),
      ...(harness === "opencode" || harness === "bedrock"
        ? [
            {
              key: "temperature",
              description: "Controls variation in model responses.",
              values:
                harness === "bedrock"
                  ? "number from 0 to 1"
                  : "number from 0 to 2",
              default: "provider default",
            },
            {
              key: "maxOutputTokens",
              description: "Maximum tokens in a model response.",
              values: "integer from 1 to 1,000,000, within the model limit",
              default: harness === "bedrock" ? "4,096" : "provider default",
            },
          ]
        : []),
    ],
  };
}

export const researchGuide: JsonGuide = {
  description:
    "Choose what the researcher may change and how candidate results are compared. Other research budgets remain in the fields above.",
  example: {
    allowedChanges: ["systemPrompt", "settings"],
    searchSpace: {
      settings: { reasoningEffort: ["low", "medium"] },
      maxSystemPromptLength: 10000,
    },
    objectiveMode: "lexicographic",
    objectiveMetrics: [
      { metric: "accuracy", direction: "maximize", weight: 1 },
      { metric: "tokens", direction: "minimize", weight: 1 },
    ],
  },
  fields: [
    {
      key: "allowedChanges",
      description: "Agent properties the researcher may change.",
      values: "array containing systemPrompt, settings, tools, model",
      default: "systemPrompt, settings, tools",
    },
    {
      key: "searchSpace.models / tools",
      description: "Optional allowed model IDs or tool names.",
      values: "arrays of strings",
      default: "no additional restriction",
    },
    {
      key: "searchSpace.settings",
      description: "Allowed values for each setting, such as reasoningEffort.",
      values: "object mapping setting names to nonempty arrays",
      default: "no additional restriction",
    },
    {
      key: "searchSpace.maxSystemPromptLength",
      description: "Maximum characters in a candidate system prompt.",
      values: "positive integer",
      default: "no additional restriction",
    },
    {
      key: "objectiveMode",
      description:
        "Lexicographic compares metrics in order. Weighted combines them using their weights.",
      values: "lexicographic or weighted",
      default: "lexicographic",
    },
    {
      key: "objectiveMetrics",
      description: "Metrics and directions for comparing candidates.",
      values:
        "array of {metric: accuracy | tokens | duration, direction: maximize | minimize, weight: positive number}",
      default: "maximize accuracy with weight 1",
    },
  ],
};

export const tableauConnectionGuide: JsonGuide = {
  description:
    "This object configures the local stdio MCP process launched by the harness; it is not a JSON request sent to the server. The Tableau URL, site, and PAT name use fields above. The PAT value uses the separate credential field. Use mcpCommand and mcpArgs to select another local server or package version. mcpEnv accepts additional server environment variables as string values. mcpFeatures accepts feature flag names as booleans and overlays them on the launched Tableau MCP package defaults. The harness reserves its authentication, transport, tool selection, and internal feature override variables. Never enter credentials here.",
  example: {
    mcpCommand: "npx",
    mcpArgs: ["-y", "@tableau/mcp-server@4.13.3"],
    mcpEnv: {
      INCLUDE_DATASOURCE_IDS: "your-datasource-id",
    },
    mcpFeatures: {
      "knowledge-tools": true,
    },
  },
  fields: [
    {
      key: "mcpCommand",
      description:
        "Local executable launched by the runtime for a compatible stdio Tableau MCP server.",
      values: "executable name or absolute path",
      default: "npx",
    },
    {
      key: "mcpArgs",
      description:
        "Array of arguments passed directly to the executable without shell parsing. Change the package version here when using npx.",
      values: "array of strings",
      default: '["-y", "@tableau/mcp-server@4.13.3"]',
    },
    {
      key: "mcpEnv",
      description:
        "Any additional MCP environment variable, including options added in future server versions. Names retain their exact case and string values pass through literally. Use the spelling expected by the server. These public values are saved with your configuration; do not include credentials or variables managed by the harness.",
      values: "object mapping environment variable names to strings",
      default: "{}",
    },
    {
      key: "mcpFeatures",
      description:
        "Feature flag overrides merged with the defaults shipped by the selected Tableau MCP package. The harness uses Tableau MCP's custom feature gate provider interface.",
      values: "object mapping feature names to booleans",
      default: "{}",
    },
  ],
};
