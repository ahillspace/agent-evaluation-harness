import type { Json, PublicQuestion } from "../../contracts.js";
import {
  pointerSegments,
  selectPointer,
  type HttpTargetConfig,
} from "../../contracts/http-target.js";

export interface HttpPublicInput {
  question: PublicQuestion;
  runId: string;
  attemptId: string;
  repetition: number;
}
export function buildHttpRequest(
  configuration: HttpTargetConfig,
  input: HttpPublicInput,
): Json {
  let body = structuredClone(configuration.body);
  const values: Record<HttpTargetConfig["bindings"][number]["source"], Json> = {
    question: input.question.text,
    context: input.question.context ?? null,
    answerFormat: (input.question.answerFormat ?? null) as Json,
    runId: input.runId,
    questionId: input.question.id,
    repetition: input.repetition,
    attemptId: input.attemptId,
  };
  for (const binding of configuration.bindings) {
    const parts = pointerSegments(binding.pointer);
    const value = structuredClone(values[binding.source]);
    if (!parts.length) {
      body = value;
      continue;
    }
    let parent = body;
    for (const part of parts.slice(0, -1))
      parent = (parent as Record<string, Json>)[part]!;
    (parent as Record<string, Json>)[parts.at(-1)!] = value;
  }
  return body;
}
export function extractHttpAnswer(response: Json, pointer: string): Json {
  return selectPointer(response, pointer);
}
