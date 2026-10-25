import {
  questionSchema,
  launchSchema,
  type AgentConfig,
  type Blueprint,
  type Json,
  type JudgeConfig,
  type JevJudgeSelection,
  type LaunchInput,
  type Question,
  type RunRecord,
  type ExternalTargetConfig,
} from "../contracts.js";
import { deriveAnswerFormat } from "../contracts/answer-format.js";
import { savedTarget } from "../contracts/targets.js";

export interface SetupDraft {
  targetKind: "managed" | "external";
  externalTarget?: ExternalTargetConfig;
  judgeEvidenceRequirement:
    "answer" | "internal-activity" | "unspecified" | undefined;
  name: string;
  bankId: string;
  bankRevisionId: string;
  evaluatorRevisionId: string;
  questionIds: string[];
  questionSelection: "all" | "selected";
  harness: AgentConfig["harness"];
  model: string;
  prompt: string;
  settings: string;
  tools: string;
  connectionId: string;
  resourceId: string;
  resourceName: string;
  resourceProjectName: string;
  providerConnectionId: string;
  providerConnectionProvider: string;
  originalConnections: AgentConfig["connections"];
  repetitions: number;
  timeoutSeconds: number;
  concurrency: number;
  maxOutputBytes: number;
  originalJudge?: JudgeConfig;
  judge: boolean;
  judgeHarness: AgentConfig["harness"];
  judgeModel: string;
  judgeInstructions: string;
  judgeSettings: string;
  judgeProviderConnectionId: string;
  judgeProviderConnectionProvider: string;
  jevEnabled: boolean;
  jevSelection: JevJudgeSelection;
  research: boolean;
  researchInstructions: string;
  allowResearcherStop: boolean;
  stopGuidance: string;
  selectionMetric: "deterministic" | "llm" | "jev";
  researcherHarness: AgentConfig["harness"];
  researcherModel: string;
  researcherPrompt: string;
  researcherSettings: string;
  originalResearcher?: AgentConfig;
  researchSettings: string;
  researcherProviderConnectionId: string;
  researcherProviderConnectionProvider: string;
  objective: string;
  guidance: string;
  maxCandidates: number;
  maxMinutes: number;
  maxTargetInvocations: number;
  maxResearcherTurns: number;
  maxTotalTokens: string;
  maxCostUsd: string;
}
export function initialSetup(): SetupDraft {
  return {
    targetKind: "managed",
    judgeEvidenceRequirement: "answer",
    name: "Evaluation run",
    bankId: "",
    bankRevisionId: "",
    evaluatorRevisionId: "",
    questionIds: [],
    questionSelection: "all",
    harness: "codex",
    model: "",
    prompt:
      "Answer the analytics question using the available tools. Return the answer clearly.",
    settings: "{}",
    tools: "",
    connectionId: "",
    resourceId: "",
    resourceName: "",
    resourceProjectName: "",
    providerConnectionId: "",
    providerConnectionProvider: "",
    originalConnections: [],
    repetitions: 1,
    timeoutSeconds: 300,
    concurrency: 1,
    maxOutputBytes: 2_000_000,
    judge: false,
    judgeHarness: "codex",
    judgeModel: "",
    judgeInstructions:
      "Assess whether the answer correctly addresses the question and expected answer.",
    judgeSettings: "{}",
    judgeProviderConnectionId: "",
    judgeProviderConnectionProvider: "",
    jevEnabled: false,
    jevSelection: { connectionId: "", model: "jev-1.13.0" },
    research: false,
    researchInstructions:
      "Improve answer accuracy without question-specific rules. Use saved evidence to propose focused changes within the allowed mutation space.",
    allowResearcherStop: true,
    stopGuidance: "",
    selectionMetric: "deterministic",
    researcherHarness: "codex",
    researcherModel: "",
    researcherPrompt:
      "Improve the analytics agent within the allowed changes. Use evidence to justify each proposal.",
    researcherSettings: "{}",
    researchSettings: JSON.stringify(
      {
        allowedChanges: ["systemPrompt", "settings", "tools"],
        objectiveMode: "lexicographic",
        objectiveMetrics: [
          { metric: "accuracy", direction: "maximize", weight: 1 },
        ],
      },
      null,
      2,
    ),
    researcherProviderConnectionId: "",
    researcherProviderConnectionProvider: "",
    objective:
      "Improve deterministic accuracy without introducing question-specific rules.",
    guidance: "",
    maxCandidates: 5,
    maxMinutes: 60,
    maxTargetInvocations: 1000,
    maxResearcherTurns: 20,
    maxTotalTokens: "",
    maxCostUsd: "",
  };
}
export function objectJson(source: string): Record<string, Json> {
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Enter a JSON object for advanced settings.");
  return value as Record<string, Json>;
}
export function roleSettings(
  source: string,
  connectionId: string,
): Record<string, Json> {
  return {
    ...objectJson(source),
    authSource: connectionId ? "connection" : "local",
  };
}
export function replaceExpectedAnswer(
  question: Question,
  expected: Json,
): Question {
  const derivedFormat = deriveAnswerFormat(question.expected);
  return {
    ...question,
    expected,
    ...(derivedFormat ? { answerFormat: undefined } : {}),
  };
}
export function createLaunch(draft: SetupDraft): LaunchInput {
  if (draft.questionSelection === "selected" && !draft.questionIds.length)
    throw new Error("Select at least one question before starting a run.");
  const settings =
    draft.targetKind === "external"
      ? {}
      : roleSettings(draft.settings, draft.providerConnectionId);
  const originalTableau = draft.originalConnections.find(
    (item) => item.provider === "tableau",
  );
  const originalProvider = draft.originalConnections.find(
    (item) => item.provider !== "tableau",
  );
  const connections = draft.originalConnections.filter(
    (item) => item !== originalTableau && item !== originalProvider,
  );
  if (draft.connectionId)
    connections.push({
      ...(originalTableau?.connectionId === draft.connectionId
        ? originalTableau
        : { settings: {}, credentialFields: [] }),
      connectionId: draft.connectionId,
      provider: "tableau",
      resourceId: draft.resourceId || undefined,
      resourceName: draft.resourceName || undefined,
      resourceProjectName: draft.resourceProjectName || undefined,
    });
  if (draft.providerConnectionId)
    connections.push({
      ...(originalProvider?.connectionId === draft.providerConnectionId
        ? originalProvider
        : { settings: {}, credentialFields: [] }),
      connectionId: draft.providerConnectionId,
      provider: draft.providerConnectionProvider || "openai",
    });
  const originalJudgeProvider = draft.originalJudge?.agent?.connections.find(
    (item) => item.provider !== "tableau",
  );
  const judgeConnections = (
    draft.originalJudge?.agent?.connections ?? []
  ).filter((item) => item !== originalJudgeProvider);
  if (draft.judgeProviderConnectionId)
    judgeConnections.push(
      originalJudgeProvider?.connectionId === draft.judgeProviderConnectionId
        ? originalJudgeProvider
        : {
            connectionId: draft.judgeProviderConnectionId,
            provider: draft.judgeProviderConnectionProvider,
            settings: {},
            credentialFields: [],
          },
    );
  return launchSchema.parse({
    name: draft.name,
    bankRevisionId: draft.bankRevisionId,
    evaluatorRevisionId: draft.evaluatorRevisionId || undefined,
    questionIds: draft.questionIds.length ? draft.questionIds : undefined,
    repetitions: draft.repetitions,
    target:
      draft.targetKind === "external"
        ? draft.externalTarget
        : {
            kind: "managed",
            agent: {
              harness: draft.harness,
              model: draft.model,
              systemPrompt: draft.prompt,
              settings,
              tools: draft.tools
                .split(/[\n,]/)
                .map((value) => value.trim())
                .filter(Boolean),
              connections,
            },
          },
    limits: {
      timeoutMs: draft.timeoutSeconds * 1000,
      concurrency: draft.concurrency,
      maxOutputBytes: draft.maxOutputBytes,
    },
    judge: {
      evidenceRequirement: draft.judgeEvidenceRequirement,
      enabled: draft.judge,
      instructions: draft.judgeInstructions,
      ...(draft.judge || draft.originalJudge?.agent
        ? {
            agent: {
              tools: [],
              ...draft.originalJudge?.agent,
              connections: judgeConnections,
              settings: roleSettings(
                draft.judgeSettings,
                draft.judgeProviderConnectionId,
              ),
              harness: draft.judgeHarness,
              model: draft.judgeModel,
              systemPrompt:
                draft.originalJudge?.agent?.systemPrompt ??
                draft.judgeInstructions,
            },
          }
        : {}),
    },
    jevJudge: draft.jevEnabled ? draft.jevSelection : undefined,
  });
}
export function restoreSetup(source: Blueprint | RunRecord): SetupDraft {
  const value = "manifest" in source ? source.manifest : source;
  const target = savedTarget(value);
  const agent = target.kind === "managed" ? target.agent : undefined;
  return {
    ...initialSetup(),
    targetKind: target.kind,
    externalTarget: target.kind === "external" ? target : undefined,
    judgeEvidenceRequirement: value.judge.evidenceRequirement,
    name: `${source.name} copy`,
    ...("manifest" in source
      ? {
          bankId: source.manifest.bank.bankId,
          bankRevisionId: source.manifest.bank.id,
          evaluatorRevisionId: source.manifest.evaluator.id,
          questionIds: source.manifest.questions.map((question) => question.id),
          questionSelection: "selected" as const,
        }
      : {}),
    harness: agent?.harness ?? "codex",
    model: agent?.model ?? "",
    prompt: agent?.systemPrompt ?? initialSetup().prompt,
    settings: JSON.stringify(agent?.settings ?? {}, null, 2),
    tools: agent?.tools.join("\n") ?? "",
    connectionId:
      agent?.connections.find((item) => item.provider === "tableau")
        ?.connectionId ?? "",
    resourceId:
      agent?.connections.find((item) => item.provider === "tableau")
        ?.resourceId ?? "",
    resourceName:
      agent?.connections.find((item) => item.provider === "tableau")
        ?.resourceName ?? "",
    resourceProjectName:
      agent?.connections.find((item) => item.provider === "tableau")
        ?.resourceProjectName ?? "",
    providerConnectionId:
      agent?.connections.find((item) => item.provider !== "tableau")
        ?.connectionId ?? "",
    providerConnectionProvider:
      agent?.connections.find((item) => item.provider !== "tableau")
        ?.provider ?? "",
    originalConnections: agent?.connections ?? [],
    repetitions: value.repetitions,
    timeoutSeconds: value.limits.timeoutMs / 1000,
    concurrency: value.limits.concurrency,
    maxOutputBytes: value.limits.maxOutputBytes,
    originalJudge: value.judge,
    jevEnabled: !!value.jevJudge,
    jevSelection: value.jevJudge
      ? {
          connectionId: value.jevJudge.connection.connectionId,
          model: value.jevJudge.model,
          profileRevisionId: value.jevJudge.profile.id,
        }
      : initialSetup().jevSelection,
    judge: value.judge.enabled,
    judgeHarness: value.judge.agent?.harness ?? "codex",
    judgeModel: value.judge.agent?.model ?? "",
    judgeInstructions: value.judge.instructions,
    judgeSettings: JSON.stringify(value.judge.agent?.settings ?? {}, null, 2),
    judgeProviderConnectionId:
      value.judge.agent?.connections.find((item) => item.provider !== "tableau")
        ?.connectionId ?? "",
    judgeProviderConnectionProvider:
      value.judge.agent?.connections.find((item) => item.provider !== "tableau")
        ?.provider ?? "",
  };
}
export function parseQuestions(source: string): Question[] {
  const trimmed = source.trim();
  if (!trimmed) throw new Error("Add at least one question.");
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const value = JSON.parse(trimmed) as unknown;
    const questions = Array.isArray(value)
      ? value
      : (value as { questions?: unknown }).questions;
    if (!Array.isArray(questions))
      throw new Error("JSON must contain a questions array.");
    return questions.map((question) => questionSchema.parse(question));
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index];
    if (char === '"') {
      if (quoted && trimmed[index + 1] === '"') {
        cell += '"';
        index++;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" && !quoted) {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (quoted) throw new Error("The CSV contains an unclosed quoted value.");
  row.push(cell.replace(/\r$/, ""));
  rows.push(row);
  const headers =
    rows.shift()?.map((header) => header.trim().toLowerCase()) ?? [];
  const textIndex =
    headers.indexOf("question") >= 0
      ? headers.indexOf("question")
      : headers.indexOf("text");
  const expectedIndex = headers.indexOf("expected");
  if (textIndex < 0 || expectedIndex < 0)
    throw new Error(
      "CSV requires question (or text) and expected columns. Optional columns: id, tags.",
    );
  return rows
    .filter((cells) => cells.some((value) => value.trim()))
    .map((cells, index) => {
      const raw = cells[expectedIndex] ?? "";
      let expected: Json = raw;
      try {
        expected = JSON.parse(raw) as Json;
      } catch {
        /* Text answers remain text. */
      }
      return questionSchema.parse({
        id: cells[headers.indexOf("id")] || `q${index + 1}`,
        text: cells[textIndex],
        expected,
        tags: (cells[headers.indexOf("tags")] ?? "").split("|").filter(Boolean),
      });
    });
}
