import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ProcessSupervisor } from "./process-supervisor.js";
import type { ProcessDriver, ProcessLaunch } from "./processes/contracts.js";

function fixtureDriver(): ProcessDriver & {
  cleaned: number;
  failCleanup: boolean;
} {
  return {
    cleaned: 0,
    failCleanup: false,
    capabilities: { hardDescendantLimit: false },
    async recover() {
      return { recovered: 0 };
    },
    async prepare() {},
    async launch(input: ProcessLaunch) {
      const child = spawn(input.executable, input.args, {
        cwd: input.cwd,
        env: input.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      return {
        child,
        stop() {
          child.kill();
        },
      };
    },
    async cleanup() {
      if (this.failCleanup) throw new Error("Unverified cleanup");
      this.cleaned++;
    },
  };
}

it("coordinates invocation slots independently of descendant limits", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aeh-coordinator-"));
  const driver = fixtureDriver();
  const supervisor = new ProcessSupervisor({
    driver,
    maxConcurrentInvocations: 1,
  });
  try {
    await supervisor.recover();
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        supervisor.run({
          executable: process.execPath,
          args: ["-e", "console.log('ready');setTimeout(()=>{},25)"],
          cwd: directory,
          processLimit: 99,
          onLine() {
            peak = Math.max(peak, supervisor.activeReservations);
          },
        }),
      ),
    );
    expect(peak).toBe(1);
    expect(results.every((result) => result.exitCode === 0)).toBe(true);
    expect(driver.cleaned).toBe(3);
    expect(supervisor.activeReservations).toBe(0);
  } finally {
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("blocks further admission when platform cleanup cannot be verified", async () => {
  const driver = fixtureDriver();
  driver.failCleanup = true;
  const supervisor = new ProcessSupervisor({
    driver,
    maxConcurrentInvocations: 1,
  });
  await supervisor.recover();
  const invocation = {
    executable: process.execPath,
    args: ["-e", ""],
    cwd: process.cwd(),
  };
  await expect(supervisor.run(invocation)).rejects.toThrow(/cleanup/i);
  await expect(supervisor.run(invocation)).rejects.toThrow(/admission/i);
  expect(supervisor.activeReservations).toBe(1);
  await supervisor.close();
});

it("stops a scope that finishes launching after shutdown starts", async () => {
  const driver = fixtureDriver();
  const launch = driver.launch.bind(driver);
  let entered!: () => void;
  let release!: () => void;
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  driver.launch = async (input) => {
    entered();
    await gate;
    return launch(input);
  };
  const supervisor = new ProcessSupervisor({ driver });
  await supervisor.recover();
  const running = supervisor.run({
    executable: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: process.cwd(),
    timeoutMs: 250,
  });
  await entering;
  const closing = supervisor.close();
  release();
  const result = await running;
  await closing;
  expect(result.interrupted).toBe(true);
  expect(result.timedOut).toBe(false);
  expect(driver.cleaned).toBe(1);
  expect(supervisor.activeReservations).toBe(0);
});
