import { z } from "zod";
import {
  agentSchema,
  connectionBindingSchema,
  judgeSchema,
  targetSchema,
  type Question,
  type ResearchInput,
} from "../contracts.js";
import { initialSetup, type SetupDraft } from "./drafts.js";

export function setupDraftKey(
  workspaceId: string | undefined,
): string | undefined {
  return workspaceId
    ? `aeh.setup-draft.v1:${encodeURIComponent(workspaceId)}`
    : undefined;
}
const defaults = initialSetup();
const primitiveFields: Record<string, z.ZodType> = {};
for (const [key, value] of Object.entries(defaults)) {
  if (typeof value === "string") primitiveFields[key] = z.string();
  else if (typeof value === "number")
    primitiveFields[key] = z.number().finite();
  else if (typeof value === "boolean") primitiveFields[key] = z.boolean();
}
const draftSchema = z.object({
  ...primitiveFields,
  targetKind: z.enum(["managed", "external"]),
  judgeEvidenceRequirement: z
    .enum(["answer", "internal-activity", "unspecified"])
    .optional(),
  questionSelection: z.enum(["all", "selected"]),
  questionIds: z.array(z.string()),
  originalConnections: z.array(connectionBindingSchema),
  originalJudge: judgeSchema.optional(),
  originalResearcher: agentSchema.optional(),
  externalTarget: targetSchema
    .refine((value) => value.kind === "external")
    .optional(),
  jevSelection: z.object({
    connectionId: z.string(),
    model: z.string(),
    profileRevisionId: z.string().optional(),
  }),
});
const snapshotSchema = z.object({
  version: z.literal(1),
  section: z.enum(["agent", "questions", "tools", "evaluation", "research"]),
  source: z.string(),
  draft: draftSchema,
});
function rejectCredentialSettings(draft: SetupDraft): void {
  const sensitiveKey =
    /"(?:api[-_]?key|password|secret|token|patValue|authorization|access[-_]?token|refresh[-_]?token|client[-_]?secret|credentials?)"\s*:/iu;
  const settings = [
    draft.settings,
    draft.judgeSettings,
    draft.researcherSettings,
    JSON.stringify(draft.originalConnections),
    JSON.stringify(draft.originalJudge),
    JSON.stringify(draft.originalResearcher),
  ];
  if (settings.some((value) => value && sensitiveKey.test(value)))
    throw new Error(
      "Keep credentials in Settings connections. This draft cannot be saved while advanced settings contain credential fields.",
    );
}

/** Form storage contains public configuration and credential references, never credential inputs. */
export function encodeSetupDraft(
  draft: SetupDraft,
  section: string,
  source: string,
): string {
  rejectCredentialSettings(draft);
  return JSON.stringify(
    snapshotSchema.parse({ version: 1, section, source, draft }),
  );
}
export function decodeSetupDraft(
  value: string | null,
): { draft: SetupDraft; section: string; source: string } | undefined {
  if (!value) return undefined;
  try {
    const raw = JSON.parse(value) as { draft?: unknown };
    const saved =
      raw.draft && typeof raw.draft === "object"
        ? (raw.draft as Partial<SetupDraft>)
        : {};
    const parsed = snapshotSchema.parse({
      ...raw,
      draft: {
        ...initialSetup(),
        ...saved,
        researchInstructions:
          saved.researchInstructions ??
          [saved.objective, saved.researcherPrompt, saved.guidance]
            .filter(Boolean)
            .join("\n\n"),
      },
    });
    const draft = { ...initialSetup(), ...parsed.draft } as SetupDraft;
    rejectCredentialSettings(draft);
    return { ...parsed, draft };
  } catch {
    return undefined;
  }
}
export function restoreResearchSetup(
  draft: SetupDraft,
  configuration: ResearchInput,
): SetupDraft {
  const provider = configuration.researcher.connections.find(
    (item) => item.provider !== "tableau",
  );
  return {
    ...draft,
    research: true,
    researchInstructions: [
      configuration.objective,
      configuration.researcher.systemPrompt === initialSetup().researcherPrompt
        ? ""
        : configuration.researcher.systemPrompt,
      configuration.guidance,
    ]
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index)
      .join("\n\n"),
    allowResearcherStop: configuration.allowResearcherStop ?? true,
    stopGuidance: configuration.stopGuidance ?? "",
    selectionMetric: configuration.selectionMetric ?? "deterministic",
    originalResearcher: configuration.researcher,
    researcherHarness: configuration.researcher.harness,
    researcherModel: configuration.researcher.model,
    researcherPrompt: configuration.researcher.systemPrompt,
    researcherSettings: JSON.stringify(
      configuration.researcher.settings,
      null,
      2,
    ),
    researcherProviderConnectionId: provider?.connectionId ?? "",
    researcherProviderConnectionProvider: provider?.provider ?? "",
    objective: configuration.objective,
    guidance: configuration.guidance,
    maxCandidates: configuration.maxCandidates,
    maxMinutes: configuration.maxDurationMs / 60_000,
    maxTargetInvocations: configuration.maxTargetInvocations,
    maxResearcherTurns: configuration.maxResearcherTurns,
    maxTotalTokens: configuration.maxTotalTokens?.toString() ?? "",
    maxCostUsd: configuration.maxCostUsd?.toString() ?? "",
    researchSettings: JSON.stringify(
      {
        allowedChanges: configuration.allowedChanges,
        searchSpace: configuration.searchSpace,
        objectiveMode: configuration.objectiveMode,
        objectiveMetrics: configuration.objectiveMetrics,
      },
      null,
      2,
    ),
  };
}
export function questionType(question: Question): string {
  if (question.answerFormat)
    return question.answerFormat.type === "scalar"
      ? question.answerFormat.valueType
      : question.answerFormat.type;
  if (question.expected === null) return "null";
  if (Array.isArray(question.expected)) return "list";
  if (
    typeof question.expected === "object" &&
    typeof question.expected.type === "string"
  )
    return question.expected.type;
  return typeof question.expected;
}
export function filterQuestions(
  questions: Question[],
  query: string,
  type: string,
  tag: string,
): Question[] {
  const search = query.trim().toLocaleLowerCase();
  return questions.filter(
    (question) =>
      (!type || questionType(question) === type) &&
      (!tag || question.tags.includes(tag)) &&
      `${question.id} ${question.text} ${question.tags.join(" ")}`
        .toLocaleLowerCase()
        .includes(search),
  );
}
export function selectedQuestionIds(
  draft: Pick<SetupDraft, "questionIds" | "questionSelection">,
  questions: Array<{ id: string }>,
): string[] {
  return draft.questionIds.length || draft.questionSelection === "selected"
    ? draft.questionIds
    : questions.map((question) => question.id);
}
