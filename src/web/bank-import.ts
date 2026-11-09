import { z } from "zod";
import {
  evaluatorSettingsSchema,
  jevProfileSettingsSchema,
  questionSchema,
  type Question,
  type EvaluatorSettings,
  type JevProfileSettings,
} from "../contracts.js";
import { parseQuestions } from "./drafts.js";

export interface BankImport {
  name?: string;
  questions: Question[];
  evaluator?: { name: string; settings: EvaluatorSettings };
  jevProfile?: { name: string; settings: JevProfileSettings };
}
const importedQuestionsSchema = z
  .array(questionSchema)
  .min(1, "Import must contain at least one question.");
const packageSchema = z
  .object({
    format: z.literal("agent-evaluation-harness/question-bank"),
    version: z.literal(1),
    name: z.string().min(1),
    questions: importedQuestionsSchema,
    evaluator: z
      .object({ name: z.string().min(1), settings: evaluatorSettingsSchema })
      .strict(),
    jevProfile: z
      .object({ name: z.string().min(1), settings: jevProfileSettingsSchema })
      .strict()
      .optional(),
    source: z
      .object({
        bankRevisionId: z.string(),
        evaluatorRevisionId: z.string(),
        jevProfileRevisionId: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const legacyRevisionSchema = z
  .object({
    questions: importedQuestionsSchema,
    name: z.string().optional(),
    id: z.string().optional(),
    bankId: z.string().optional(),
    number: z.number().optional(),
    createdAt: z.string().optional(),
    digest: z.string().optional(),
  })
  .strict();
export function parseBankImport(source: string): BankImport {
  try {
    const trimmed = source.trim();
    if (trimmed && !trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      const headers = trimmed
        .split(/\r?\n/, 1)[0]!
        .split(",")
        .map((header) => header.trim().replace(/^"|"$/g, "").toLowerCase());
      const supported = new Set(["question", "text", "expected", "id", "tags"]);
      const unsupported = headers.filter((header) => !supported.has(header));
      if (unsupported.length)
        throw new Error(
          `Unsupported CSV columns: ${unsupported.join(", ")}. Use a versioned JSON package to preserve public context, answer instructions, and grading rules.`,
        );
    }
    if (source.trim().startsWith("{")) {
      const value: unknown = JSON.parse(source);
      if (
        value &&
        typeof value === "object" &&
        ("format" in value || "evaluator" in value || "jevProfile" in value)
      ) {
        const parsed = packageSchema.parse(value);
        return {
          name: parsed.name,
          questions: parsed.questions,
          evaluator: parsed.evaluator,
          ...(parsed.jevProfile ? { jevProfile: parsed.jevProfile } : {}),
        };
      }
      const legacy = legacyRevisionSchema.parse(value);
      return {
        questions: legacy.questions,
        ...(legacy.name ? { name: legacy.name } : {}),
      };
    }
    return { questions: importedQuestionsSchema.parse(parseQuestions(source)) };
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new Error(
        error.issues
          .map((issue) =>
            issue.path.length
              ? `${issue.path.join(".")}: ${issue.message}`
              : issue.message,
          )
          .join("\n"),
        { cause: error },
      );
    throw error;
  }
}
