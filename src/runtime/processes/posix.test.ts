import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProcessSupervisor } from "../process-supervisor.js";
import { inheritedEnvironment } from "../commands.js";
import { PosixProcessDriver } from "./posix.js";
import { readLease, processIdentity } from "./posix-state.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "aeh-posix-"));
  const supervisor = new ProcessSupervisor({
    driver: new PosixProcessDriver(directory),
    maxConcurrentInvocations: 2,
  });
  cleanup.push(async () => {
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  });
  await supervisor.recover();
  return { directory, supervisor };
}
describe.skipIf(process.platform === "win32")(
  "managed POSIX process scopes",
  () => {
    it("preserves stdin and arguments without leaking helper events into output", async () => {
      const { directory, supervisor } = await setup();
      const result = await supervisor.run({
        executable: process.execPath,
        args: [
          "-e",
          "let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>console.log(JSON.stringify([process.argv[1],s])))",
          "a b",
        ],
        cwd: directory,
        input: "hello",
        timeoutMs: 10000,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(["a b", "hello"]);
      expect(
        (await readdir(path.join(directory, "process-scopes"))).filter((name) =>
          name.endsWith(".json"),
        ),
      ).toEqual([]);
    });
    it("stops a stubborn descendant when the direct target exits", async () => {
      const { directory, supervisor } = await setup();
      const result = await supervisor.run({
        executable: process.execPath,
        args: [
          "-e",
          "const c=require('node:child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});console.log(c.pid);setTimeout(()=>process.exit(0),100)",
        ],
        cwd: directory,
        timeoutMs: 10000,
      });
      const pid = Number(result.stdout.trim());
      expect(pid).toBeGreaterThan(1);
      expect(() => process.kill(pid, 0)).toThrow();
    });
    it("cancels an active invocation and releases its reservation", async () => {
      const { directory, supervisor } = await setup();
      const controller = new AbortController();
      const running = supervisor.run({
        executable: process.execPath,
        args: ["-e", "console.log('ready');setInterval(()=>{},1000)"],
        cwd: directory,
        signal: controller.signal,
        onLine() {
          controller.abort();
        },
      });
      expect((await running).interrupted).toBe(true);
      expect(supervisor.activeReservations).toBe(0);
    });
    it("settles cancellation during watchdog initialization without launching the target", async () => {
      const { directory, supervisor } = await setup();
      for (let attempt = 0; attempt < 4; attempt++) {
        const result = await supervisor.run({
          executable: process.execPath,
          args: [
            "-e",
            "console.log('unexpected target');setInterval(()=>{},1000)",
          ],
          cwd: directory,
          timeoutMs: 1,
        });
        expect(result.timedOut).toBe(true);
        expect(result.stdout).toBe("");
        expect(supervisor.activeReservations).toBe(0);
      }
    }, 15000);
    it("rejects a recovery record pointing at an unrelated live process", async () => {
      const { directory } = await setup();
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        { stdio: "ignore" },
      );
      await once(child, "spawn");
      cleanup.push(async () => {
        child.kill("SIGKILL");
        await once(child, "exit");
      });
      const id = randomUUID();
      const filename = path.join(directory, "process-scopes", `${id}.json`);
      await writeFile(
        filename,
        JSON.stringify({
          version: 1,
          kind: "posix",
          id,
          state: "running",
          watchdogPid: child.pid,
          watchdogStarted: (await processIdentity(child.pid!))!.started,
        }),
      );
      await expect(new PosixProcessDriver(directory).recover()).rejects.toThrow(
        "identity changed",
      );
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      expect(await readFile(filename, "utf8")).toContain(id);
    });
    it("bounds output and timeout through the shared coordinator", async () => {
      const { directory, supervisor } = await setup();
      const output = await supervisor.run({
        executable: process.execPath,
        args: [
          "-e",
          "process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000)",
        ],
        cwd: directory,
        maxOutputBytes: 128,
      });
      expect(output.outputLimited).toBe(true);
      expect(Buffer.byteLength(output.stdout)).toBeLessThanOrEqual(128);
      const timeout = await supervisor.run({
        executable: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        cwd: directory,
        timeoutMs: 1000,
      });
      expect(timeout.timedOut).toBe(true);
      expect(supervisor.activeReservations).toBe(0);
    }, 15000);
    it("stops its process group when the engine IPC connection disappears", async () => {
      const { directory } = await setup();
      const driver = new PosixProcessDriver(directory);
      const id = randomUUID();
      await driver.prepare(id);
      const scope = await driver.launch({
        id,
        executable: process.execPath,
        args: ["-e", "console.log(process.pid);setInterval(()=>{},1000)"],
        cwd: directory,
        env: inheritedEnvironment(),
        processLimit: 4,
      });
      const exited = once(scope.child, "exit");
      const [output] = await once(scope.child.stdout, "data");
      const pid = Number(String(output).trim());
      scope.child.disconnect();
      await exited;
      expect(pid).toBeGreaterThan(1);
      expect(() => process.kill(pid, 0)).toThrow();
      await driver.cleanup(id);
    }, 15000);
    it("recovers a frozen watchdog before deleting its ownership record", async () => {
      const { directory } = await setup();
      const driver = new PosixProcessDriver(directory);
      const id = randomUUID();
      await driver.prepare(id);
      const scope = await driver.launch({
        id,
        executable: process.execPath,
        args: ["-e", "console.log('ready');setInterval(()=>{},1000)"],
        cwd: directory,
        env: inheritedEnvironment(),
        processLimit: 4,
      });
      const exited = once(scope.child, "exit");
      await once(scope.child.stdout, "data");
      const lease = await readLease(
        path.join(directory, "process-scopes", `${id}.json`),
      );
      process.kill(lease.watchdogPid!, "SIGSTOP");
      await driver.cleanup(id);
      expect(() => process.kill(lease.watchdogPid!, 0)).toThrow();
      await exited;
    }, 15000);
  },
);
