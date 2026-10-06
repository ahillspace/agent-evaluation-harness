import { z } from "zod";
export const executionFailureSchema = z
  .object({
    category: z.enum([
      "provider-capacity",
      "rate-limit",
      "authentication",
      "configuration",
      "missing-answer",
      "submission",
      "tool",
      "harness",
      "timeout",
      "unknown",
    ]),
    transient: z.boolean(),
    retrySafety: z.enum([
      "not-started",
      "no-side-effects",
      "unsafe",
      "unknown",
    ]),
    retryAfterMs: z.number().finite().nonnegative().optional(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().optional(),
        cachedInputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional(),
        costUsd: z.number().finite().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ExecutionFailure = z.infer<typeof executionFailureSchema>;
