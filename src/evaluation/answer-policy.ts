import type { EvaluatorSettings, Json } from "../contracts.js";

/** A single row and single cell carry one scalar; larger shapes retain their structure. */
export function scalarRepresentation(answer: Json): Json {
  let value = answer;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as Json;
    } catch {
      return answer;
    }
  }
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.type === "table" &&
    Array.isArray(value.rows) &&
    Object.keys(value).every((key) => ["type", "columns", "rows"].includes(key))
  )
    value = value.rows;
  if (!Array.isArray(value) || value.length !== 1) return answer;
  const row = value[0]!;
  const cells =
    row && typeof row === "object" && !Array.isArray(row)
      ? Object.values(row)
      : [row];
  return cells.length === 1 &&
    (cells[0] === null || typeof cells[0] !== "object")
    ? cells[0]!
    : answer;
}

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
