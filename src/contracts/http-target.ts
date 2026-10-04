import { z } from "zod";
import { jsonSchema, type Json } from "./json.js";

const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);
export function pointerSegments(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/") || /~(?![01])/u.test(pointer))
    throw new Error("Use a valid JSON Pointer.");
  const parts = pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (parts.length > 32 || parts.some((part) => unsafeKeys.has(part)))
    throw new Error("The JSON Pointer contains an unsupported path.");
  return parts;
}
export function selectPointer(value: Json, pointer: string): Json {
  let current = value;
  for (const part of pointerSegments(pointer)) {
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current, part) ||
      (Array.isArray(current) && !/^(0|[1-9]\d*)$/u.test(part))
    )
      throw new Error("The JSON Pointer does not select an existing value.");
    current = (current as Record<string, Json>)[part]!;
  }
  return current;
}
function boundedJson(value: Json, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value !== "object") return true;
  return Object.entries(value).every(
    ([key, item]) => !unsafeKeys.has(key) && boundedJson(item, depth + 1),
  );
}
const pointerSchema = z
  .string()
  .max(2000)
  .refine((value) => {
    try {
      pointerSegments(value);
      return true;
    } catch {
      return false;
    }
  }, "Use a supported JSON Pointer.");
const headerName = z
  .string()
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u)
  .max(200);
const forbiddenHeaders = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authorization",
  "content-type",
  "accept-encoding",
  "upgrade",
  "trailer",
  "te",
]);
const sensitiveName =
  /(?:authorization|password|secret|token|api[-_]?key|credential|signature)/iu;
export const httpTargetSchema = z
  .object({
    endpoint: z.string().url().max(8000),
    authentication: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("none") }).strict(),
        z
          .object({
            kind: z.literal("bearer"),
            credentialReference: z.string().min(1).max(2000),
          })
          .strict(),
        z
          .object({
            kind: z.literal("api-key"),
            header: headerName,
            credentialReference: z.string().min(1).max(2000),
          })
          .strict(),
      ])
      .default({ kind: "none" }),
    headers: z
      .record(
        headerName,
        z
          .string()
          .max(8000)
          .refine((value) => !/[\r\n\0]/u.test(value)),
      )
      .default({}),
    body: jsonSchema.default({
      question: null,
      context: null,
      answerFormat: null,
    }),
    bindings: z
      .array(
        z
          .object({
            pointer: pointerSchema,
            source: z.enum([
              "question",
              "context",
              "answerFormat",
              "runId",
              "questionId",
              "repetition",
              "attemptId",
            ]),
          })
          .strict(),
      )
      .max(100)
      .default([
        { pointer: "/question", source: "question" },
        { pointer: "/context", source: "context" },
        { pointer: "/answerFormat", source: "answerFormat" },
      ]),
    answerPointer: pointerSchema.default("/answer"),
    deploymentLabel: z.string().max(500).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: z.ZodIssueCode.custom, message });
    let url: URL;
    try {
      url = new URL(value.endpoint);
    } catch {
      issue("Use a valid endpoint URL.");
      return;
    }
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      )
    )
      issue("Use HTTPS, or HTTP on a loopback development endpoint.");
    if (
      url.username ||
      url.password ||
      url.hash ||
      [...url.searchParams.keys()].some((name) => sensitiveName.test(name))
    )
      issue("Endpoint URLs cannot contain credentials or fragments.");
    const names = Object.keys(value.headers).map((name) => name.toLowerCase());
    if (
      names.length > 50 ||
      new Set(names).size !== names.length ||
      names.some(
        (name) => forbiddenHeaders.has(name) || sensitiveName.test(name),
      )
    )
      issue(
        "Use unique non-secret headers; configure authentication separately.",
      );
    if (value.authentication.kind === "api-key") {
      const name = value.authentication.header.toLowerCase();
      if (forbiddenHeaders.has(name) || names.includes(name))
        issue(
          "The API key header conflicts with a reserved or configured header.",
        );
    }
    if (
      !boundedJson(value.body) ||
      new TextEncoder().encode(JSON.stringify(value.body)).length > 1_048_576
    )
      issue(
        "The request template exceeds supported size or depth, or contains unsafe keys.",
      );
    let paths: string[][];
    try {
      paths = value.bindings.map((binding) => pointerSegments(binding.pointer));
    } catch {
      issue("Use supported JSON Pointer bindings.");
      return;
    }
    paths.forEach((parts, index) => {
      try {
        selectPointer(value.body, value.bindings[index]!.pointer);
      } catch {
        issue("Every input binding must select an existing template slot.");
      }
      if (
        paths.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            other.length <= parts.length &&
            other.every((part, offset) => part === parts[offset]),
        )
      )
        issue("Input bindings cannot overlap.");
    });
  });
export type HttpTargetConfig = z.infer<typeof httpTargetSchema>;
