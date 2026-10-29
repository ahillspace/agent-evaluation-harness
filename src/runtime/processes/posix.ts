import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ProcessDriver,
  ProcessLaunch,
  ProcessScope,
} from "./contracts.js";
import { processEntry } from "./entry.js";
import {
  delay,
  drainGroup,
  inspectGroup,
  readLease,
  verifyOwner,
  processIdentity,
} from "./posix-state.js";

/** Managed groups for cooperative providers, not a hard descendant sandbox. */
export class PosixProcessDriver implements ProcessDriver {
  readonly capabilities = { hardDescendantLimit: false };
  private readonly directory: string;
  constructor(stateDirectory: string) {
    this.directory = path.resolve(stateDirectory, "process-scopes");
  }
  private filename(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new Error("Invalid scope identifier.");
    return path.join(this.directory, `${id}.json`);
  }
  async recover() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let recovered = 0;
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith(".json")) continue;
      await this.cleanup(name.slice(0, -5));
      recovered++;
    }
    return { recovered };
  }
  async prepare(id: string) {
    await writeFile(
      this.filename(id),
      JSON.stringify({ version: 1, kind: "posix", id, state: "prepared" }),
      { flag: "wx", mode: 0o600 },
    );
  }
  async launch(input: ProcessLaunch): Promise<ProcessScope> {
    const entry = processEntry("posix-watchdog");
    const child = spawn(
      process.execPath,
      [...entry.args, input.id, this.filename(input.id)],
      {
        cwd: input.cwd,
        env: input.env,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        detached: true,
      },
    ) as ChildProcessWithoutNullStreams;
    child.once("spawn", () => {
      if (child.connected) child.send({ type: "launch", input }, () => {});
    });
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    child.once("exit", () => clearTimeout(stopTimer));
    return {
      child,
      stop: () => {
        if (stopTimer || child.exitCode !== null || child.signalCode !== null)
          return;
        if (child.connected) child.send({ type: "stop" }, () => {});
        else child.kill("SIGTERM");
        // A frozen or failed watchdog cannot leave cancellation waiting forever.
        stopTimer = setTimeout(() => {
          void (async () => {
            try {
              const lease = await readLease(this.filename(input.id));
              if (lease.id !== input.id)
                throw new Error("Scope identity mismatch.");
              if (
                lease.runnerPid &&
                (await inspectGroup(lease.runnerPid)).status !== "empty"
              )
                await drainGroup(lease.runnerPid, {
                  verify: () =>
                    verifyOwner(
                      lease.runnerPid!,
                      lease.runnerStarted,
                      input.id,
                      processEntry("posix-runner").source,
                    ),
                });
            } finally {
              if (child.exitCode === null && child.signalCode === null)
                child.kill("SIGKILL");
            }
          })().catch(() => {
            /* cleanup() preserves unresolved ownership and closes admission. */
          });
        }, 2000);
      },
    };
  }
  async cleanup(id: string) {
    const filename = this.filename(id);
    let lease = await readLease(filename);
    if (lease.id !== id) throw new Error("Process recovery identity mismatch.");
    if (
      lease.watchdogPid &&
      (await verifyOwner(
        lease.watchdogPid,
        lease.watchdogStarted,
        id,
        processEntry("posix-watchdog").source,
      ))
    ) {
      process.kill(lease.watchdogPid, "SIGTERM");
      for (let attempt = 0; attempt < 120; attempt++) {
        lease = await readLease(filename);
        if (lease.state === "cleaned") break;
        await delay(50);
      }
      // Recovery cannot leave a suspended writer able to recreate its lease later.
      if (
        await verifyOwner(
          lease.watchdogPid!,
          lease.watchdogStarted,
          id,
          processEntry("posix-watchdog").source,
        )
      )
        process.kill(lease.watchdogPid!, "SIGKILL");
      for (
        let attempt = 0;
        attempt < 40 && (await processIdentity(lease.watchdogPid!));
        attempt++
      )
        await delay(50);
      if (await processIdentity(lease.watchdogPid!))
        throw new Error("Owned watchdog did not settle.");
      // IPC disconnect gives the runner time to finish its own group shutdown.
      for (
        let attempt = 0;
        attempt < 20 &&
        lease.runnerPid &&
        (await inspectGroup(lease.runnerPid)).status === "live";
        attempt++
      )
        await delay(50);
    }
    if (
      lease.runnerPid &&
      (await inspectGroup(lease.runnerPid)).status !== "empty"
    ) {
      await drainGroup(lease.runnerPid, {
        verify: () =>
          verifyOwner(
            lease.runnerPid!,
            lease.runnerStarted,
            id,
            processEntry("posix-runner").source,
          ),
      });
    }
    await unlink(filename);
  }
}
