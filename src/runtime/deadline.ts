/** Covers admission waits and provider work, while still awaiting complete cleanup. */
export async function withInvocationDeadline<T>(
  timeoutMs: number,
  requestedSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([requestedSignal, timeout]);
  try {
    signal.throwIfAborted();
    const value = await operation(signal);
    signal.throwIfAborted();
    return value;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "cleanup_failed"
    )
      throw error;
    const code = requestedSignal.aborted
      ? "interrupted"
      : timeout.aborted
        ? "timeout"
        : undefined;
    if (!code) throw error;
    throw Object.assign(
      new Error(
        code === "timeout"
          ? "The invocation exceeded its time limit."
          : "The invocation was interrupted.",
      ),
      error && typeof error === "object" ? error : {},
      { code },
    );
  }
}
