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
    "Optional Tableau MCP process settings. Leave {} to use the bundled integration. Never enter credentials here.",
  example: {},
  fields: [
    {
      key: "mcpCommand",
      description: "Executable for a compatible Tableau MCP server.",
      values: "executable name or absolute path",
      default: "bundled Tableau MCP command",
    },
    {
      key: "mcpArgs",
      description: "Arguments passed directly to that executable.",
      values: "array of strings",
      default: "bundled arguments",
    },
  ],
};
