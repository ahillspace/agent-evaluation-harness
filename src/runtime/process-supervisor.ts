import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { inheritedEnvironment, resolveCommand } from "./commands.js";
import type { ProcessDriver } from "./processes/contracts.js";
import type { ExecutionFailure } from "../contracts/execution-failure.js";

export interface ProcessSpec {
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  input?: string;
  keepStdinOpen?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  processLimit?: number;
  signal?: AbortSignal;
  onLine?: (line: string, write: (line: string) => void) => void;
}
export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  interrupted: boolean;
  timedOut: boolean;
  outputLimited: boolean;
  durationMs: number;
}

export type ProcessInteraction = Pick<
  ProcessSpec,
  "input" | "keepStdinOpen" | "signal" | "onLine"
>;

// An agent has at most 20 connection bindings plus one role-specific bridge.
const MAX_INVOCATION_SCOPES = 21;

/** One admission owns a fixed plan and every scope's verified cleanup. */
export class ProcessInvocation {
  private readonly stop = new AbortController();
  private readonly started = new Set<number>();
  private readonly pending: Promise<ProcessResult>[] = [];
  private closing?: Promise<"complete" | "unavailable">;
  private unresolved = false;
  readonly signal: AbortSignal;

  constructor(
    private readonly plan: readonly ProcessSpec[],
    signal: AbortSignal | undefined,
    private readonly launch: (spec: ProcessSpec) => Promise<ProcessResult>,
    private readonly release: (cleaned: boolean) => void,
  ) {
    this.signal = signal
      ? AbortSignal.any([signal, this.stop.signal])
      : this.stop.signal;
  }

  async run(
    index: number,
    interaction: ProcessInteraction = {},
  ): Promise<ProcessResult> {
    if (this.closing) throw new Error("Process invocation is closed.");
    this.signal.throwIfAborted();
    const spec = this.plan[index];
    if (!Number.isInteger(index) || !spec || this.started.has(index))
      throw new Error("Process scope is not available in the invocation plan.");
    this.started.add(index);
    const signals = [this.signal, spec.signal, interaction.signal].filter(
      (value): value is AbortSignal => value !== undefined,
    );
    const work = this.launch({
      ...spec,
      ...interaction,
      signal: AbortSignal.any(signals),
    }).catch((error: unknown) => {
      if (error instanceof ProcessCleanupFailure) this.unresolved = true;
      throw error;
    });
    this.pending.push(work);
    return work;
  }

  close(): Promise<"complete" | "unavailable"> {
    this.closing ??= (async () => {
      this.stop.abort();
      await Promise.allSettled(this.pending);
      this.release(!this.unresolved);
      return this.unresolved ? "unavailable" : "complete";
    })();
    return this.closing;
  }
}

/** Internal handoff for a completed process whose ownership cleanup failed. */
export class ProcessCleanupFailure extends Error {
  readonly code = "cleanup_failed";
  evidence?: unknown;
  executionFailure?: ExecutionFailure;
  #processResult?: ProcessResult;
  #originalError?: unknown;

  constructor(input: {
    processResult?: ProcessResult;
    cause?: unknown;
    message?: string;
  }) {
    const originalMessage =
      input.cause instanceof Error ? input.cause.message : undefined;
    super(
      input.message ??
        (originalMessage
          ? `${originalMessage} Process cleanup also failed; runtime admissions are stopped.`
          : "Process cleanup failed. Runtime admissions are stopped."),
    );
    this.name = "ProcessCleanupFailure";
    this.#originalError = input.cause;
    this.#processResult = input.processResult;
  }

  takeProcessResult(): ProcessResult | undefined {
    const result = this.#processResult;
    this.#processResult = undefined;
    return result;
  }
  takeOriginalError(): unknown {
    const error = this.#originalError;
    this.#originalError = undefined;
    return error;
  }
}

/** Only safe diagnostics may cross the provider/runtime boundary. */
export function cleanupFailure(
  diagnostic?: {
    message: string;
    code?: string;
    providerCode?: string | null;
    statusCode?: number | null;
    providerDiagnostics?: { name?: string; code?: string };
  },
  executionFailure?: ExecutionFailure,
): ProcessCleanupFailure {
  const failure = new ProcessCleanupFailure({
    message: diagnostic
      ? `${diagnostic.message.slice(0, 1000)} Process cleanup also failed; runtime admissions are stopped.`
      : "Process cleanup failed. Runtime admissions are stopped.",
  });
  if (diagnostic)
    failure.evidence = {
      ...diagnostic,
      message: diagnostic.message.slice(0, 1000),
    };
  if (executionFailure) failure.executionFailure = executionFailure;
  return failure;
}

class ProcessExecutionFailure extends Error {
  constructor(readonly result: ProcessResult) {
    super(result.stderr.trim());
  }
}

/** Coordinates runtime invocations through owned process scopes. */
export class ProcessSupervisor {
  private reserved = 0;
  private readonly waiters = new Set<() => void>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly invocations = new Set<ProcessInvocation>();
  private readonly active = new Map<
    string,
    { stop: () => void; done: Promise<void> }
  >();
  private ready = false;
  private closed = false;
  private poisoned = false;
  readonly maxConcurrentInvocations: number;
  private readonly driver: ProcessDriver;

  constructor(options: {
    driver: ProcessDriver;
    maxConcurrentInvocations?: number;
  }) {
    this.driver = options.driver;
    this.maxConcurrentInvocations = options.maxConcurrentInvocations ?? 4;
    if (
      !Number.isInteger(this.maxConcurrentInvocations) ||
      this.maxConcurrentInvocations < 1
    )
      throw new Error("Invalid invocation capacity.");
  }
  get activeReservations(): number {
    return this.reserved;
  }

  async recover(): Promise<{ recovered: number }> {
    if (this.inflight.size)
      throw new Error("Cannot recover active process scopes.");
    const report = await this.driver.recover();
    this.ready = true;
    return report;
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    while (this.reserved >= this.maxConcurrentInvocations) {
      signal?.throwIfAborted();
      if (this.closed || this.poisoned)
        throw new Error("Process admission is closed.");
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          this.waiters.delete(wake);
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          this.waiters.delete(wake);
          reject(signal?.reason ?? new Error("Interrupted."));
        };
        this.waiters.add(wake);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
    signal?.throwIfAborted();
    if (this.closed || this.poisoned)
      throw new Error("Process admission is closed.");
    this.reserved++;
  }

  async acquireInvocation(
    plan: readonly ProcessSpec[],
    signal?: AbortSignal,
  ): Promise<ProcessInvocation> {
    if (this.closed) throw new Error("Process admission is closed.");
    if (!this.ready)
      throw new Error("Recover process scopes before starting runtime work.");
    if (plan.length < 1 || plan.length > MAX_INVOCATION_SCOPES)
      throw new Error("Invalid invocation process scope plan.");
    const scopes = plan.map((spec) => {
      const limit = spec.processLimit ?? 12;
      if (!Number.isInteger(limit) || limit < 1)
        throw new Error("Invalid process scope limit.");
      return {
        ...spec,
        args: [...spec.args],
        env: spec.env ? { ...spec.env } : undefined,
      };
    });
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.inflight.add(done);
    let acquired = false;
    try {
      await this.acquire(signal);
      acquired = true;
      signal?.throwIfAborted();
      if (this.closed || this.poisoned)
        throw new Error("Process admission is closed.");
      const invocation = new ProcessInvocation(
        scopes,
        signal,
        (spec) => this.runOwned(spec, done),
        (cleaned) => {
          if (cleaned) this.reserved--;
          else this.poisoned = true;
          this.invocations.delete(invocation);
          this.inflight.delete(done);
          finish();
          for (const wake of [...this.waiters]) wake();
        },
      );
      this.invocations.add(invocation);
      return invocation;
    } catch (error) {
      if (acquired) this.reserved--;
      this.inflight.delete(done);
      finish();
      for (const wake of [...this.waiters]) wake();
      throw error;
    }
  }

  async run(spec: ProcessSpec): Promise<ProcessResult> {
    const invocation = await this.acquireInvocation([spec], spec.signal);
    try {
      return await invocation.run(0);
    } finally {
      await invocation.close();
    }
  }

  private async runOwned(
    spec: ProcessSpec,
    done: Promise<void>,
  ): Promise<ProcessResult> {
    const limit = spec.processLimit ?? 12;
    spec.signal?.throwIfAborted();
    if (this.closed || this.poisoned)
      throw new Error("Process admission is closed.");
    const id = randomUUID();
    let cleaned = false;
    try {
      await this.driver.prepare(id);
      let result: ProcessResult | undefined;
      let executionError: unknown;
      try {
        spec.signal?.throwIfAborted();
        if (this.closed || this.poisoned)
          throw new Error("Process admission is closed.");
        result = await this.spawnScope(spec, limit, id, done);
      } catch (error) {
        executionError = error;
        if (error instanceof ProcessExecutionFailure) result = error.result;
      }
      try {
        await this.driver.cleanup(id);
        cleaned = true;
      } catch {
        throw new ProcessCleanupFailure({
          processResult: result,
          cause: executionError,
        });
      }
      if (executionError instanceof ProcessExecutionFailure) {
        this.poisoned = true;
        throw new ProcessCleanupFailure({
          processResult: result,
          cause: executionError,
        });
      }
      if (executionError) throw executionError;
      return result!;
    } catch (error) {
      if (!cleaned && !(error instanceof ProcessCleanupFailure))
        throw new ProcessCleanupFailure({ cause: error });
      throw error;
    } finally {
      this.active.delete(id);
      if (!cleaned) this.poisoned = true;
      for (const wake of [...this.waiters]) wake();
    }
  }

  private async spawnScope(
    spec: ProcessSpec,
    limit: number,
    id: string,
    done: Promise<void>,
  ): Promise<ProcessResult> {
    const started = Date.now();
    const env = { ...inheritedEnvironment(), ...spec.env };
    const command = resolveCommand(spec.executable, spec.args, env);
    let interrupted = false,
      timedOut = false,
      outputLimited = false;
    let captured = 0,
      pending = "",
      stdout = "",
      stderr = "";
    let callbackError: unknown;
    const maximum = spec.maxOutputBytes ?? 4 * 1024 * 1024;
    const scope = await this.driver.launch({
      id,
      executable: command.executable,
      args: command.args,
      cwd: spec.cwd,
      env,
      processLimit: limit,
    });
    const child = scope.child;
    const stop = () => scope.stop();
    const abort = () => {
      interrupted = true;
      stop();
    };
    this.active.set(id, { stop: abort, done });
    const write = (line: string) => {
      if (!child.stdin.destroyed) child.stdin.write(line);
    };
    child.stdin.on("error", () => {
      /* A target can close input before cancellation settles. */
    });
    const emit = (line: string) => {
      if (callbackError) return;
      try {
        spec.onLine?.(line, write);
      } catch (error) {
        callbackError = error;
        stop();
      }
    };
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    child.stdout.on("data", (chunk: Buffer) => {
      const available = Math.max(0, maximum - captured);
      const text = stdoutDecoder.write(chunk.subarray(0, available));
      captured += Math.min(available, chunk.length);
      stdout += text;
      pending += text;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        emit(pending.slice(0, newline).replace(/\r$/, ""));
        pending = pending.slice(newline + 1);
      }
      if (chunk.length > available) {
        outputLimited = true;
        stop();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const available = Math.max(0, maximum - captured);
      stderr += stderrDecoder.write(chunk.subarray(0, available));
      captured += Math.min(available, chunk.length);
      if (chunk.length > available) {
        outputLimited = true;
        stop();
      }
    });
    spec.signal?.addEventListener("abort", abort, { once: true });
    // Shutdown can start while the platform driver is still launching the scope.
    if (spec.signal?.aborted || this.closed || this.poisoned) abort();
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, spec.timeoutMs ?? 120_000);
    try {
      const completion = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      if (spec.keepStdinOpen) {
        if (spec.input) write(spec.input);
      } else child.stdin.end(spec.input);
      const exitCode = await completion;
      const finalText = stdoutDecoder.end();
      stdout += finalText;
      pending += finalText;
      stderr += stderrDecoder.end();
      if (pending) emit(pending);
      if (callbackError) throw callbackError;
      const result = {
        exitCode,
        stdout,
        stderr,
        interrupted,
        timedOut,
        outputLimited,
        durationMs: Date.now() - started,
      };
      if (exitCode === 125 && stderr.includes("Containment:"))
        throw new ProcessExecutionFailure(result);
      return result;
    } finally {
      clearTimeout(timeout);
      spec.signal?.removeEventListener("abort", abort);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const wake of [...this.waiters]) wake();
    const active = [...this.active.values()];
    for (const scope of active) scope.stop();
    await Promise.all(
      [...this.invocations].map((invocation) => invocation.close()),
    );
    await Promise.all([...this.inflight]);
  }
}
