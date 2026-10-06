import {
  executionFailureSchema,
  type ExecutionFailure,
} from "../contracts/execution-failure.js";
export function classifyExecutionFailure(error: unknown): ExecutionFailure {
  const object =
    error !== null && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  const declared = executionFailureSchema.safeParse(object.executionFailure);
  if (declared.success) return declared.data;
  const code = String(object.code ?? "unknown");
  const category =
    code === "timeout"
      ? "timeout"
      : ["tool_failure", "tool_rejected"].includes(code)
        ? "tool"
        : code === "configuration_error"
          ? "configuration"
          : code === "answer_missing"
            ? "missing-answer"
            : code === "submission_rejected"
              ? "submission"
              : code === "authentication_failed"
                ? "authentication"
                : [
                      "target_failure",
                      "cleanup_failed",
                      "infrastructure_failure",
                      "output_limit",
                    ].includes(code)
                  ? "harness"
                  : "unknown";
  return { category, transient: false, retrySafety: "unknown" };
}
export function automaticRetryDelay(
  failure: ExecutionFailure,
  attemptNumber: number,
  kind: string,
  random = Math.random(),
): number | undefined {
  if (
    kind !== "managed" ||
    attemptNumber >= 3 ||
    !failure.transient ||
    !["not-started", "no-side-effects"].includes(failure.retrySafety) ||
    !["provider-capacity", "rate-limit"].includes(failure.category) ||
    (failure.retryAfterMs ?? 0) > 30000
  )
    return undefined;
  const exponential = Math.min(
    10000,
    500 * 2 ** Math.max(0, attemptNumber - 1),
  );
  return Math.min(
    30000,
    Math.max(
      failure.retryAfterMs ?? 0,
      Math.round(exponential * (1 + Math.max(0, Math.min(1, random)))),
    ),
  );
}
