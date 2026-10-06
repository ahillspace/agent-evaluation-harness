import type { ExecutionFailure } from "../contracts/execution-failure.js";
import type { RuntimeEvent } from "../contracts.js";

/** Provider tool envelopes establish a rejection; natural-language output never does. */
export function toolEventRejected(event: RuntimeEvent): boolean {
  if (!event.type.startsWith("tool.")) return false;
  const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const data = object(event.data),
    result = object(data.result),
    state = object(data.state);
  return (
    data.isError === true ||
    data.is_error === true ||
    result.isError === true ||
    state.status === "error" ||
    data.status === "failed" ||
    Boolean(data.error)
  );
}
/** Provider envelopes, never natural-language messages, establish transient failure categories. */
export function providerExecutionFailure(input: {
  status?: number;
  providerCode?: string;
  toolFree: boolean;
  toolActivity: boolean;
  admissionRejected?: boolean;
  retryAfterMs?: number;
  usage?: ExecutionFailure["usage"];
}): ExecutionFailure {
  const category =
    input.status === 429
      ? "rate-limit"
      : [503, 529].includes(input.status ?? 0) ||
          input.providerCode === "model_capacity"
        ? "provider-capacity"
        : [401, 403].includes(input.status ?? 0)
          ? "authentication"
          : "harness";
  return {
    category,
    transient: ["rate-limit", "provider-capacity"].includes(category),
    retrySafety: input.toolActivity
      ? "unsafe"
      : input.admissionRejected && category === "provider-capacity"
        ? "not-started"
        : input.toolFree
          ? "no-side-effects"
          : "unknown",
    ...(input.retryAfterMs !== undefined &&
    Number.isFinite(input.retryAfterMs) &&
    input.retryAfterMs >= 0
      ? { retryAfterMs: input.retryAfterMs }
      : {}),
    ...(input.usage ? { usage: input.usage } : {}),
  };
}
