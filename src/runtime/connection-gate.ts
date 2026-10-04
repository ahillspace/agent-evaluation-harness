import { createHash } from "node:crypto";

export function tableauSessionKey(server: string, token: string): string {
  return createHash("sha256")
    .update(`${server.replace(/\/$/, "").toLowerCase()}\0${token}`)
    .digest("hex");
}

/** Tableau PAT sessions sharing a credential cannot overlap, including connection probes. */
export class ConnectionGate {
  private readonly held = new Set<string>();
  private readonly waiters = new Set<() => void>();

  async acquire(
    keys: string[],
    signal?: AbortSignal,
    onWait?: () => void,
  ): Promise<() => void> {
    const unique = [...new Set(keys)];
    let notified = false;
    while (unique.some((key) => this.held.has(key))) {
      signal?.throwIfAborted();
      if (!notified) {
        notified = true;
        onWait?.();
      }
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
    for (const key of unique) this.held.add(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const key of unique) this.held.delete(key);
      for (const wake of [...this.waiters]) wake();
    };
  }
}
