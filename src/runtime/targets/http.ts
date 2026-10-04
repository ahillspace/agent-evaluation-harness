import type { Json, RuntimeEvent } from "../../contracts.js";
import { jsonSchema } from "../../contracts/json.js";
import {
  httpTargetSchema,
  type HttpTargetConfig,
} from "../../contracts/http-target.js";
import {
  buildHttpRequest,
  extractHttpAnswer,
  type HttpPublicInput,
} from "./http-mapping.js";

export class HttpTargetFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly remoteCompletion: "not-dispatched" | "unknown",
    public readonly evidence?: {
      request: Json;
      startedAt: string;
      finishedAt: string;
      httpStatus?: number;
    },
  ) {
    super(message);
    this.name = "HttpTargetFailure";
  }
}
export interface HttpTargetResult {
  answer: Json;
  request: Json;
  response: Json;
  httpStatus: number;
  startedAt: string;
  finishedAt: string;
  remoteCompletion: "observed";
}
export interface HttpTargetInput extends HttpPublicInput {
  configuration: HttpTargetConfig;
  credential?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
  onDispatch(): Promise<void>;
  onEvent(event: RuntimeEvent): void;
}
function containsCredential(value: Json, credential: string): boolean {
  if (typeof value === "string") return value.includes(credential);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, item]) =>
      key.includes(credential) || containsCredential(item, credential),
  );
}
export async function executeHttpTarget(
  input: HttpTargetInput,
): Promise<HttpTargetResult> {
  let dispatched = false;
  let request: Json | undefined;
  let httpStatus: number | undefined;
  const startedAt = new Date().toISOString();
  const timeout = AbortSignal.timeout(input.timeoutMs);
  const signal = AbortSignal.any([input.signal, timeout]);
  const failure = (code: string, message: string) =>
    new HttpTargetFailure(
      code,
      message,
      dispatched ? "unknown" : "not-dispatched",
      request === undefined
        ? undefined
        : {
            request,
            startedAt,
            finishedAt: new Date().toISOString(),
            ...(httpStatus === undefined ? {} : { httpStatus }),
          },
    );
  try {
    signal.throwIfAborted();
    const configuration = httpTargetSchema.parse(input.configuration);
    if (
      input.credential &&
      containsCredential(configuration as Json, input.credential)
    )
      throw failure(
        "credential_leak",
        "Public endpoint configuration contains a configured credential.",
      );
    request = buildHttpRequest(configuration, input);
    const serialized = JSON.stringify(request);
    if (
      Buffer.byteLength(serialized) > Math.min(1_048_576, input.maxOutputBytes)
    )
      throw failure("request_too_large", "The request exceeds its byte limit.");
    if (input.credential && containsCredential(request, input.credential)) {
      request = undefined;
      throw failure(
        "credential_leak",
        "The request contains a configured credential.",
      );
    }
    const headers = new Headers({
      ...configuration.headers,
      "Content-Type": "application/json",
    });
    if (configuration.authentication.kind !== "none") {
      if (!input.credential || /[\r\n\0]/u.test(input.credential))
        throw failure(
          "credentials_unavailable",
          "A valid endpoint credential is required.",
        );
      headers.set(
        configuration.authentication.kind === "bearer"
          ? "Authorization"
          : configuration.authentication.header,
        configuration.authentication.kind === "bearer"
          ? `Bearer ${input.credential}`
          : input.credential,
      );
    }
    await input.onDispatch();
    signal.throwIfAborted();
    dispatched = true;
    input.onEvent({
      type: "request.dispatched",
      message: "Request sent. Remote completion is not yet known.",
    });
    const response = await fetch(configuration.endpoint, {
      method: "POST",
      headers,
      body: serialized,
      redirect: "manual",
      credentials: "omit",
      signal,
    });
    httpStatus = response.status;
    if (!response.ok || response.status === 202 || response.status === 204) {
      await response.body?.cancel();
      throw failure(
        "http_error",
        `The endpoint returned unsupported HTTP status ${response.status}.`,
      );
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      if (reader)
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > Math.min(4_194_304, input.maxOutputBytes)) {
            await reader.cancel();
            throw failure(
              "response_too_large",
              "The endpoint response exceeds its byte limit.",
            );
          }
          chunks.push(chunk.value);
        }
    } finally {
      reader?.releaseLock();
    }
    signal.throwIfAborted();
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks),
      );
    } catch {
      throw failure(
        "invalid_json",
        "The endpoint response is not valid UTF-8 JSON.",
      );
    }
    if (input.credential && text.includes(input.credential))
      throw failure(
        "credential_leak",
        "The endpoint response contains a configured credential; the answer was not accepted.",
      );
    let parsed: Json;
    try {
      parsed = jsonSchema.parse(JSON.parse(text));
    } catch {
      throw failure(
        "invalid_json",
        "The endpoint did not return a valid JSON response.",
      );
    }
    if (input.credential && containsCredential(parsed, input.credential))
      throw failure(
        "credential_leak",
        "The endpoint response contains a configured credential; the answer was not accepted.",
      );
    let answer: Json;
    try {
      answer = extractHttpAnswer(parsed, configuration.answerPointer);
    } catch {
      throw failure(
        "answer_missing",
        "The configured answer field is missing from the endpoint response.",
      );
    }
    input.onEvent({
      type: "request.completed",
      message: "Answer received.",
      data: { httpStatus },
    });
    return {
      answer,
      request,
      response: parsed,
      httpStatus,
      startedAt,
      finishedAt: new Date().toISOString(),
      remoteCompletion: "observed",
    };
  } catch (error) {
    if (input.signal.aborted)
      throw failure(
        "interrupted",
        "The harness stopped waiting. Dispatched remote work might continue.",
      );
    if (timeout.aborted)
      throw failure(
        "timeout",
        "The request deadline expired. Dispatched remote work might continue.",
      );
    if (error instanceof HttpTargetFailure) throw error;
    throw failure(
      dispatched ? "transport_error" : "configuration_error",
      dispatched
        ? "The endpoint request failed. Remote completion is unknown."
        : "The endpoint configuration could not be prepared.",
    );
  }
}
