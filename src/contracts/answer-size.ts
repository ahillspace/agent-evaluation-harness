import type { Json } from "../contracts.js";

export const LARGE_ANSWER_TOKENS = 2_000;
export const JEV_ANSWER_LIMIT_TOKENS = 32_000;
export const ESTIMATED_BYTES_PER_TOKEN = 4;
export interface AnswerSizeEstimate {
  bytes: number;
  tokens: number;
  severity: "normal" | "warning" | "danger";
}
/** A portable size estimate, not a model tokenizer or a payload admission guarantee. */
export function expectedAnswerSize(answer: Json): AnswerSizeEstimate {
  const bytes = new TextEncoder().encode(JSON.stringify(answer)).length;
  const tokens = Math.ceil(bytes / ESTIMATED_BYTES_PER_TOKEN);
  return {
    bytes,
    tokens,
    severity:
      tokens >= JEV_ANSWER_LIMIT_TOKENS
        ? "danger"
        : tokens >= LARGE_ANSWER_TOKENS
          ? "warning"
          : "normal",
  } as const;
}
