import type { Json } from "../contracts.js";
import type { ProcessSupervisor, ProcessSpec } from "./process-supervisor.js";

/** A stdio client whose complete process tree belongs to the runtime supervisor. */
export class McpSession {
  private serial = 1;
  private writer?: (line: string) => void;
  private readonly stop = new AbortController();
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly running: Promise<unknown>;
  readonly ready: Promise<unknown>;
  private closed = false;
  constructor(supervisor: ProcessSupervisor, command: ProcessSpec) {
    this.ready = new Promise((resolve, reject) =>
      this.pending.set(1, { resolve, reject }),
    );
    this.running = supervisor
      .run({
        ...command,
        signal: command.signal
          ? AbortSignal.any([command.signal, this.stop.signal])
          : this.stop.signal,
        keepStdinOpen: true,
        input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "aeh", version: "1" } } })}\n`,
        onLine: (line, write) => {
          let value: { id?: number; result?: unknown; error?: unknown };
          try {
            value = JSON.parse(line);
          } catch {
            return;
          }
          if (typeof value.id !== "number") return;
          const request = this.pending.get(value.id);
          if (!request) return;
          this.pending.delete(value.id);
          this.writer = write;
          if (value.error) request.reject(new Error("MCP request failed."));
          else {
            if (value.id === 1)
              write(
                `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
              );
            request.resolve(value.result);
          }
        },
      })
      .finally(() => {
        this.closed = true;
        for (const request of this.pending.values())
          request.reject(
            new Error("MCP connection closed before its response."),
          );
        this.pending.clear();
      });
    // Observe early process failures while callers await the handshake.
    void this.running.catch(() => undefined);
  }
  async request(
    method: string,
    params: Record<string, Json> = {},
  ): Promise<unknown> {
    await this.ready;
    if (this.closed || !this.writer)
      throw new Error("MCP connection is closed.");
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.writer!(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }
  async close(): Promise<void> {
    this.stop.abort();
    await this.running;
  }
}
