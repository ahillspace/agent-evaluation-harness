import { spawn, type ChildProcess } from "node:child_process";
import { processEntry } from "./entry.js";
import {
  drainGroup,
  readLease,
  writeLease,
  processIdentity,
  verifyOwner,
  type PosixLease,
} from "./posix-state.js";
import type { ProcessLaunch } from "./contracts.js";

const id = process.argv[2]!;
const filename = process.argv[3]!;
let lease: PosixLease;
let runner: ChildProcess | undefined;
let stopping = false;
let finalizing: Promise<void> | undefined;
let requested: ProcessLaunch | undefined;
let ready = false;
let pendingWrite = Promise.resolve();
function persist(value: PosixLease) {
  pendingWrite = pendingWrite.then(() => writeLease(filename, value));
  return pendingWrite;
}

async function finish(code: number) {
  stopping = true;
  if (finalizing) return finalizing;
  finalizing = (async () => {
    try {
      await initialization;
      if (runner?.pid) {
        const pid = runner.pid;
        const identity = await processIdentity(pid);
        const started = lease.runnerStarted ?? identity?.started;
        await drainGroup(pid, () =>
          verifyOwner(pid, started, id, processEntry("posix-runner").source),
        );
      }
      if (lease) await persist({ ...lease, state: "cleaned" });
    } catch (error) {
      process.stderr.write(
        `Containment: Managed process cleanup could not be verified: ${error instanceof Error ? error.message : "Unknown cleanup error"}.\n`,
      );
      code = 125;
    }
    process.stdin.destroy();
    runner?.stdin?.destroy();
    runner?.stdout?.destroy();
    runner?.stderr?.destroy();
    if (runner?.connected) runner.disconnect();
    if (process.connected) process.disconnect();
    process.exitCode = code;
  })();
  return finalizing;
}
function launch(input: ProcessLaunch) {
  if (runner || stopping || !process.connected) return;
  const entry = processEntry("posix-runner");
  runner = spawn(process.execPath, [...entry.args, id], {
    cwd: input.cwd,
    env: input.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  process.stdin.pipe(runner.stdin!);
  runner.stdin!.on("error", () => {});
  runner.stdout!.pipe(process.stdout);
  runner.stderr!.pipe(process.stderr);
  runner.on("message", (message: { type: string; code?: number }) => {
    if (message.type === "ready")
      void (async () => {
        if (stopping) return;
        const identity = await processIdentity(runner!.pid!);
        if (!identity) throw new Error("Group leader unavailable.");
        if (stopping) return;
        lease = {
          ...lease,
          state: "running",
          runnerPid: runner!.pid,
          runnerStarted: identity.started,
        };
        await persist(lease);
        if (stopping || !process.connected) await finish(130);
        else runner!.send({ type: "launch", input }, () => {});
      })().catch(() => finish(125));
    else if (message.type === "exit") void finish(message.code ?? 125);
    else if (message.type === "stop_requested") void finish(130);
  });
  runner.once("error", () => {
    void finish(125);
  });
  runner.once("exit", () => {
    if (!stopping) void finish(125);
  });
}
process.on("SIGTERM", () => {
  void finish(130);
});
process.on("SIGINT", () => {
  void finish(130);
});
process.on("disconnect", () => {
  void finish(130);
});
process.on("message", (message: { type: string; input?: ProcessLaunch }) => {
  if (message.type === "stop") void finish(130);
  else if (message.type === "launch" && message.input?.id === id) {
    requested = message.input;
    if (ready) launch(requested);
  }
});
const initialization = (async () => {
  lease = await readLease(filename);
  if (lease.id !== id) throw new Error("Scope identity mismatch.");
  const identity = await processIdentity(process.pid);
  if (!identity) throw new Error("Watchdog unavailable.");
  lease = {
    ...lease,
    watchdogPid: process.pid,
    watchdogStarted: identity.started,
  };
  await persist(lease);
  ready = true;
})();
try {
  await initialization;
  if (!process.connected || stopping) await finish(130);
  else if (requested) launch(requested);
} catch {
  process.stderr.write("Containment: Managed process initialization failed.\n");
  await finish(125);
}
