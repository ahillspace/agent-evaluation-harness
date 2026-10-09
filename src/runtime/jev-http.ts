import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Json, TargetOutput } from "../contracts.js";
import { redact } from "./harness.js";
import { withInvocationDeadline } from "./deadline.js";
import { safeFetchFailureDetails } from "./safe-fetch-diagnostics.js";

export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1";
export interface HttpAttempt {
  status: number;
  response: Json;
  requestId?: string;
}
export class JevFailure extends Error {
  request?: Json;
  response?: Json;
  requestId?: string;
  usage?: TargetOutput["usage"];
  httpStatus?: number;
  attempts?: HttpAttempt[];
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "JevFailure";
  }
}
const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
});
export function reportedUsage(response: Json): TargetOutput["usage"] {
  if (!response || typeof response !== "object" || Array.isArray(response))
    return undefined;
  const parsed = usageSchema.safeParse(response.usage);
  return parsed.success
    ? {
        inputTokens: parsed.data.input_tokens,
        outputTokens: parsed.data.output_tokens,
      }
    : undefined;
}
function totalUsage(attempts: HttpAttempt[]): TargetOutput["usage"] {
  const usages = attempts
    .map((attempt) => reportedUsage(attempt.response))
    .filter((usage) => usage !== undefined);
  return usages.length
    ? {
        inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens!, 0),
        outputTokens: usages.reduce(
          (sum, usage) => sum + usage.outputTokens!,
          0,
        ),
      }
    : undefined;
}
async function boundedBody(
  response: Response,
  maximum: number,
): Promise<string> {
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel();
    throw new JevFailure(
      "response_too_large",
      "The Jev response exceeds the response byte limit. No partial response was accepted.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new JevFailure(
          "response_too_large",
          "The Jev response exceeds the response byte limit. No partial response was accepted.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
function retryDelay(header: string | null, attempt: number): number {
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0)
      return Math.min(seconds * 1000, 2_147_483_647);
    const date = Date.parse(header);
    if (Number.isFinite(date))
      return Math.min(Math.max(0, date - Date.now()), 2_147_483_647);
  }
  return 250 * 2 ** attempt;
}

/** Retries only explicit admission rejections; ambiguous failures may already be billable. */
export async function jevHttp(input: {
  endpoint: string;
  apiKey: string;
  request?: Json;
  signal: AbortSignal;
  timeoutMs: number;
  maxResponseBytes?: number;
  secrets?: string[];
  onRequest?: (request: Json) => void;
}) {
  const secrets = [input.apiKey, ...(input.secrets ?? [])];
  const request =
    input.request === undefined
      ? undefined
      : (JSON.parse(redact(JSON.stringify(input.request), secrets)) as Json);
  const attempts: HttpAttempt[] = [];
  let lastResponse: Json | undefined;
  let requestId: string | undefined;
  let status: number | undefined;
  let unresolvedUsage = false;
  try {
    return await withInvocationDeadline(
      input.timeoutMs,
      input.signal,
      async (signal) => {
        if (request !== undefined) input.onRequest?.(request);
        for (let attempt = 0; attempt < 3; attempt++) {
          signal.throwIfAborted();
          unresolvedUsage = true;
          lastResponse = undefined;
          requestId = undefined;
          status = undefined;
          let response: Response;
          try {
            response = await fetch(input.endpoint, {
              method: request === undefined ? "GET" : "POST",
              headers: {
                authorization: `Bearer ${input.apiKey}`,
                ...(request === undefined
                  ? {}
                  : { "content-type": "application/json" }),
              },
              body: request === undefined ? undefined : JSON.stringify(request),
              signal,
              redirect: "manual",
            });
          } catch (error) {
            throw new JevFailure(
              "provider_failure",
              `The TypeSafe request failed before a complete HTTP response${safeFetchFailureDetails(error)}. It was not retried because provider usage is unknown.`,
            );
          }
          status = response.status;
          requestId =
            response.headers.get("x-request-id") ??
            response.headers.get("request-id") ??
            undefined;
          if (requestId) requestId = redact(requestId, secrets);
          const text = redact(
            await boundedBody(response, input.maxResponseBytes ?? 1_048_576),
            secrets,
          );
          let validJson = true;
          try {
            lastResponse = JSON.parse(text) as Json;
          } catch {
            lastResponse = text;
            validJson = false;
          }
          attempts.push({
            status,
            response: lastResponse!,
            ...(requestId ? { requestId } : {}),
          });
          // Explicit rate/overload rejections have not admitted model work.
          // Every accepted or ambiguous request needs reported usage before totals are known.
          unresolvedUsage =
            reportedUsage(lastResponse!) === undefined &&
            status !== 429 &&
            status !== 529;
          if ((status === 429 || status === 529) && attempt < 2) {
            await delay(
              retryDelay(response.headers.get("retry-after"), attempt),
              undefined,
              { signal },
            );
            continue;
          }
          if (!response.ok) {
            const body =
              lastResponse &&
              typeof lastResponse === "object" &&
              !Array.isArray(lastResponse)
                ? lastResponse
                : {};
            const structuredCodes = [body.error, body.detail, body].flatMap(
              (value) =>
                value && typeof value === "object" && !Array.isArray(value)
                  ? [value.code, value.error_type, value.type]
                  : [],
            );
            const tokenLimit =
              [400, 413, 422].includes(status) &&
              structuredCodes.some(
                (value) =>
                  value === "max_tokens_exceeded" ||
                  value === "context_length_exceeded" ||
                  value === "token_limit_exceeded",
              );
            const code = tokenLimit
              ? "token_limit_exceeded"
              : status === 422
                ? /context|token|length|capacity|too (?:long|large)/i.test(text)
                  ? "capacity_exceeded"
                  : "invalid_request"
                : status === 401 || status === 403
                  ? "authentication_failed"
                  : status === 429 || status === 529
                    ? "provider_unavailable"
                    : "provider_failure";
            throw new JevFailure(
              code,
              tokenLimit
                ? `TypeSafe did not judge this answer because the complete request exceeded its token limit (HTTP ${status}). The full request and response remain available; evidence was not truncated.`
                : `TypeSafe rejected the request (HTTP ${status}).${status === 422 ? " Check the preserved response for context capacity or request validation details; evidence was not truncated." : ""}`,
            );
          }
          if (!validJson)
            throw new JevFailure(
              "invalid_provider_response",
              "TypeSafe returned invalid JSON.",
            );
          return {
            response: lastResponse!,
            requestId,
            attempts,
            usage: unresolvedUsage ? undefined : totalUsage(attempts),
          };
        }
        throw new JevFailure(
          "provider_unavailable",
          "TypeSafe remained unavailable after bounded retries.",
        );
      },
    );
  } catch (error) {
    const failure =
      error instanceof JevFailure
        ? error
        : new JevFailure(
            error &&
              typeof error === "object" &&
              "code" in error &&
              typeof error.code === "string"
              ? error.code
              : "provider_failure",
            error instanceof Error
              ? redact(error.message, secrets)
              : "TypeSafe evaluation failed.",
          );
    Object.assign(failure, {
      request,
      response: lastResponse,
      requestId,
      httpStatus: status,
      attempts,
      usage: unresolvedUsage ? undefined : totalUsage(attempts),
    });
    throw failure;
  }
}
