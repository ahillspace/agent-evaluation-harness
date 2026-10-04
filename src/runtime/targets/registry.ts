import type {
  Json,
  TargetConfig,
  ExternalTargetConfig,
  PublicQuestion,
} from "../../contracts.js";
import type { TargetAdapter, TargetInvocation } from "./contracts.js";

/** Composition-owned adapters share admission, without depending on native processes. */
export class TargetRegistry {
  private readonly adapters = new Map<string, TargetAdapter>();
  private active = 0;
  private closed = false;
  private unsafe = false;
  private readonly shutdown = new AbortController();
  private readonly waiters = new Set<() => void>();
  private readonly pending = new Set<Promise<unknown>>();
  constructor(
    adapters: TargetAdapter[],
    private readonly capacity: number,
    private readonly recoveryTimeoutMs = 30_000,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new Error("Invalid target capacity.");
    if (!Number.isInteger(recoveryTimeoutMs) || recoveryTimeoutMs < 1)
      throw new Error("Invalid target recovery deadline.");
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.id))
        throw new Error("Duplicate target adapter.");
      this.adapters.set(adapter.id, adapter);
    }
  }
  private adapter(target: TargetConfig) {
    const id = target.kind === "managed" ? "managed" : target.adapterId;
    const adapter = this.adapters.get(id);
    if (
      !adapter ||
      (target.kind === "external" && target.adapterVersion !== adapter.version)
    )
      throw new Error(
        "The target adapter or configuration version is unavailable.",
      );
    return adapter;
  }
  async resolve(target: TargetConfig) {
    const adapter = this.adapter(target);
    return {
      target: await adapter.resolve(target),
      capabilities: { ...adapter.capabilities },
    };
  }
  validate(target: ExternalTargetConfig): ExternalTargetConfig {
    const result = this.adapter(target).validate(target);
    if (result.kind !== "external")
      throw new Error("Expected an external target.");
    return result;
  }
  credentials(target: ExternalTargetConfig) {
    const binding = this.adapter(target).credentials;
    if (!binding)
      throw new Error("The external adapter has no credential contract.");
    return binding.call(this.adapter(target), target);
  }
  preview(target: TargetConfig, question: PublicQuestion) {
    const adapter = this.adapter(target);
    if (!adapter.preview)
      throw new Error(
        "Public request preview is unavailable for this adapter.",
      );
    return adapter.preview(target, question);
  }
  async recover(target: TargetConfig, checkpoint: Json) {
    if (this.closed) throw new Error("Target recovery is closed.");
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new Error("Target recovery deadline expired.")),
      this.recoveryTimeoutMs,
    );
    const signal = AbortSignal.any([this.shutdown.signal, deadline.signal]);
    let onAbort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () =>
        reject(
          new Error("Target recovery did not settle within its deadline."),
        );
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    const work = (async () => {
      try {
        const report = await Promise.race([
          this.adapter(target).recover({
            target: structuredClone(target),
            checkpoint: structuredClone(checkpoint),
            signal,
            timeoutMs: this.recoveryTimeoutMs,
          }),
          cancelled,
        ]);
        if (report.cleanup !== "complete") this.unsafe = true;
        return report;
      } catch {
        this.unsafe = true;
        throw Object.assign(
          new Error(
            "Target recovery is unresolved. No additional target work can start.",
          ),
          { code: "cleanup_failed" },
        );
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }
    })();
    this.pending.add(work);
    try {
      return await work;
    } finally {
      this.pending.delete(work);
    }
  }
  async invoke(input: TargetInvocation) {
    if (this.closed) throw new Error("Target admission is closed.");
    this.requireSafe();
    const work = this.admit(input);
    this.pending.add(work);
    try {
      return await work;
    } finally {
      this.pending.delete(work);
    }
  }
  private requireSafe(): void {
    if (this.unsafe)
      throw Object.assign(
        new Error(
          "Target resource cleanup is unresolved. Restart and recover before admitting more work.",
        ),
        { code: "cleanup_failed" },
      );
  }
  private async admit(input: TargetInvocation) {
    const deadline = AbortSignal.timeout(input.timeoutMs);
    const signal = AbortSignal.any([
      input.signal,
      this.shutdown.signal,
      deadline,
    ]);
    try {
      while (this.active >= this.capacity) {
        this.requireSafe();
        signal.throwIfAborted();
        input.onEvent({
          type: "target.waiting",
          message: "Waiting for target capacity.",
        });
        await new Promise<void>((resolve, reject) => {
          const wake = () => {
            this.waiters.delete(wake);
            signal.removeEventListener("abort", abort);
            resolve();
          };
          const abort = () => {
            this.waiters.delete(wake);
            reject(signal.reason);
          };
          this.waiters.add(wake);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      }
      signal.throwIfAborted();
      this.requireSafe();
      this.active++;
      let cleaned = true;
      try {
        const adapter = this.adapter(input.target);
        const output = await adapter.invoke({
          ...input,
          signal,
        });
        if (output.cleanup !== "complete") cleaned = false;
        if (
          !["complete", "unavailable"].includes(output.cleanup) ||
          output.evidenceScope !== adapter.capabilities.observation
        ) {
          cleaned = false;
          throw Object.assign(
            new Error(
              "The target adapter returned incompatible evidence or cleanup guarantees.",
            ),
            { code: "cleanup_failed" },
          );
        }
        return output;
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "cleanup_failed"
        )
          cleaned = false;
        throw error;
      } finally {
        if (cleaned) this.active--;
        else this.unsafe = true;
        for (const wake of [...this.waiters]) wake();
      }
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "cleanup_failed"
      )
        throw error;
      if (deadline.aborted && !input.signal.aborted)
        throw Object.assign(
          new Error("The target invocation exceeded its time limit."),
          error && typeof error === "object" ? error : {},
          { code: "timeout" },
        );
      throw error;
    }
  }
  async close() {
    this.closed = true;
    this.shutdown.abort(new Error("Target runtime is closing."));
    await Promise.allSettled([...this.pending]);
    await Promise.all(
      [...this.adapters.values()].map((adapter) => adapter.close()),
    );
  }
}
