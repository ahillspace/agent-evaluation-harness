import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { acquireOwnerLock } from "./owner-lock.js";

const directories: string[] = [];
const releases: Array<() => Promise<void>> = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
  for (const release of releases.splice(0).reverse()) await release();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function directory() {
  const value = await mkdtemp(join(tmpdir(), "aeh-owner-"));
  directories.push(value);
  return value;
}

describe("exclusive engine ownership", () => {
  it("admits exactly one competing owner and releases idempotently", async () => {
    const location = await directory();
    const starts = await Promise.allSettled(
      Array.from({ length: 8 }, () => acquireOwnerLock(location)),
    );
    const owners = starts.filter((entry) => entry.status === "fulfilled");
    expect(owners).toHaveLength(1);
    const release = owners[0]!.value;
    releases.push(release);
    await release();
    await release();
    const next = await acquireOwnerLock(location);
    releases.push(next);
  });

  it("recovers after engine death without a stale-PID deletion race", async () => {
    const location = await directory();
    const moduleUrl = new URL("./owner-lock.ts", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `const {acquireOwnerLock}=await import(${JSON.stringify(moduleUrl)}); await acquireOwnerLock(${JSON.stringify(location)}); process.stdout.write('owned\\n'); setInterval(()=>{},1000);`,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    const ready = await once(child.stdout!, "data");
    expect(String(ready[0])).toContain("owned");
    await expect(acquireOwnerLock(location)).rejects.toMatchObject({
      code: "workspace_locked",
    });
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const starts = await Promise.allSettled(
      Array.from({ length: 8 }, () => acquireOwnerLock(location)),
    );
    const owners = starts.filter((entry) => entry.status === "fulfilled");
    for (const owner of owners) releases.push(owner.value);
    expect(owners).toHaveLength(1);
  }, 15_000);
});
