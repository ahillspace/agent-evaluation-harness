import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { inheritedEnvironment, resolveCommand } from "./commands.js";
import type { ProcessDriver } from "./processes/contracts.js";

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

/** Internal handoff for a completed process whose ownership cleanup failed. */
export class ProcessCleanupFailure extends Error {
  readonly code = "cleanup_failed";
  cause?: unknown;
  evidence?: unknown;
  private readonly processResult?: ProcessResult;

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
    this.cause = input.cause;
    this.processResult = input.processResult;
    Object.defineProperty(this, "cause", {
      enumerable: false,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(this, "processResult", {
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  takeProcessResult(): ProcessResult | undefined {
    return this.processResult;
  }

  preserveOriginal(input: {
    error: Error;
    message?: string;
    diagnostic?: unknown;
  }): this {
    this.cause = input.error;
    if (input.diagnostic !== undefined) this.evidence = input.diagnostic;
    this.message = `${(input.message ?? input.error.message).slice(0, 1000)} Process cleanup also failed; runtime admissions are stopped.`;
    return this;
  }
}

/** Coordinates runtime invocations through owned process scopes. */
export class ProcessSupervisor {
  private reserved = 0;
  private readonly waiters = new Set<() => void>();
  private readonly inflight = new Set<Promise<void>>();
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
    if (this.active.size)
      throw new Error("Cannot recover active process scopes.");
    const report = await this.driver.recover();
    this.ready = true;
    return report;
  }

  private async acquire(cost: number, signal?: AbortSignal): Promise<void> {
    if (cost > this.maxConcurrentInvocations)
      throw new Error(
        "The requested process scope exceeds the invocation capacity.",
      );
    while (this.reserved + cost > this.maxConcurrentInvocations) {
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
    this.reserved += cost;
  }

  async run(spec: ProcessSpec): Promise<ProcessResult> {
    if (this.closed) throw new Error("Process admission is closed.");
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.inflight.add(done);
    try {
      return await this.runOwned(spec, done);
    } finally {
      this.inflight.delete(done);
      finish();
    }
  }

  private async runOwned(
    spec: ProcessSpec,
    done: Promise<void>,
  ): Promise<ProcessResult> {
    if (!this.ready)
      throw new Error("Recover process scopes before starting runtime work.");
    const limit = spec.processLimit ?? 12;
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error("Invalid process scope limit.");
    const cost = 1;
    await this.acquire(cost, spec.signal);
    const id = randomUUID();
    let cleaned = false;
    try {
      await this.driver.prepare(id);
      let result: ProcessResult | undefined;
      let executionError: unknown;
      try {
        if (this.closed || this.poisoned)
          throw new Error("Process admission is closed.");
        result = await this.spawnScope(spec, limit, id, done);
      } catch (error) {
        executionError = error;
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
      if (executionError) throw executionError;
      return result!;
    } finally {
      this.active.delete(id);
      if (cleaned) this.reserved -= cost;
      else this.poisoned = true;
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
      if (exitCode === 125 && stderr.includes("Containment:"))
        throw new Error(stderr.trim());
      return {
        exitCode,
        stdout,
        stderr,
        interrupted,
        timedOut,
        outputLimited,
        durationMs: Date.now() - started,
      };
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
    await Promise.all([...this.inflight]);
  }
}
