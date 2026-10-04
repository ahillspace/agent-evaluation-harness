import type { EvaluatorSettings, Json } from "../contracts.js";

export function selectAnswer(
  answer: Json,
  settings: EvaluatorSettings,
): { value: Json; missing: boolean } {
  let value = answer;
  if (settings.answerPath) {
    for (const encoded of settings.answerPath.slice(1).split("/")) {
      const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
      if (
        value === null ||
        typeof value !== "object" ||
        !Object.hasOwn(value, key)
      )
        return { value: null, missing: true };
      if (Array.isArray(value)) {
        if (!/^(0|[1-9][0-9]*)$/.test(key))
          return { value: null, missing: true };
        value = value[Number(key)]!;
      } else value = value[key]!;
    }
  }
  if (settings.unwrapSingleton && Array.isArray(value) && value.length === 1)
    value = value[0]!;
  return { value, missing: false };
}
