import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ProcessSupervisor } from "./process-supervisor.js";
import {
  ProcessCleanupFailure,
  ProcessSupervisor as ProcessSupervisorImpl,
} from "./process-supervisor.js";
import { createProcessSupervisor } from "./platform.js";

const directories: string[] = [];
const supervisors: ProcessSupervisor[] = [];
async function setup(maxConcurrentInvocations = 10) {
  const directory = await mkdtemp(path.join(tmpdir(), "aeh-process-test-"));
  directories.push(directory);
  const supervisor = createProcessSupervisor({
    stateDirectory: directory,
    maxConcurrentInvocations,
  });
  supervisors.push(supervisor);
  await supervisor.recover();
  return { directory, supervisor };
}
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((value) => value.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((value) => rm(value, { recursive: true, force: true })),
  );
});

it("keeps the execution error when process cleanup also fails", async () => {
  const executionError = Object.assign(
    new Error("Gateway returned model_not_found"),
    { code: "infrastructure_failure" },
  );
  const supervisor = new ProcessSupervisorImpl({
    driver: {
      capabilities: { hardDescendantLimit: false },
      recover: async () => ({ recovered: 0 }),
      prepare: async () => {},
      launch: async () => {
        throw executionError;
      },
      cleanup: async () => {
        throw new Error("Private cleanup path details.");
      },
    },
  });
  await supervisor.recover();
  try {
    await expect(
      supervisor.run({ executable: process.execPath, args: [], cwd: "." }),
    ).rejects.toMatchObject({
      code: "cleanup_failed",
      message: expect.stringContaining("Gateway returned model_not_found"),
    });
    expect(supervisor.activeReservations).toBe(1);
  } finally {
    await supervisor.close();
  }
});

it("keeps a completed provider result internal when process cleanup fails", async () => {
  const supervisor = new ProcessSupervisorImpl({
    driver: {
      capabilities: { hardDescendantLimit: false },
      recover: async () => ({ recovered: 0 }),
      prepare: async () => {},
      launch: async (input) => {
        const child = spawn(input.executable, input.args, {
          cwd: input.cwd,
          env: input.env,
          stdio: "pipe",
        });
        return { child, stop: () => child.kill() };
      },
      cleanup: async () => {
        throw new Error("Private cleanup path details.");
      },
    },
  });
  await supervisor.recover();
  try {
    let failure: unknown;
    try {
      await supervisor.run({
        executable: process.execPath,
        args: ["-e", 'console.log("model_not_found")'],
        cwd: process.cwd(),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProcessCleanupFailure);
    expect((failure as ProcessCleanupFailure).code).toBe("cleanup_failed");
    expect(
      (failure as ProcessCleanupFailure).takeProcessResult()?.stdout,
    ).toContain("model_not_found");
    expect(JSON.stringify(failure)).not.toContain("model_not_found");
  } finally {
    await supervisor.close();
  }
});

it.skipIf(["win32", "darwin"].includes(process.platform))(
  "rejects unsupported platforms before admitting provider work",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "aeh-platform-test-"));
    directories.push(directory);
    const supervisor = createProcessSupervisor({ stateDirectory: directory });
    supervisors.push(supervisor);
    await expect(supervisor.recover()).rejects.toThrow(
      "Live runtime execution supports Windows and macOS.",
    );
    await expect(
      supervisor.run({
        executable: process.execPath,
        args: [],
        cwd: directory,
      }),
    ).rejects.toThrow("Recover process scopes");
    expect(supervisor.activeReservations).toBe(0);
  },
);

describe.skipIf(!["win32", "darwin"].includes(process.platform))(
  "process ownership",
  () => {
    it("waits for admitted calls that have not spawned before close completes", async () => {
      const { directory, supervisor } = await setup();
      const running = supervisor.run({
        executable: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        cwd: directory,
        processLimit: 2,
      });
      const settled = running.catch(() => undefined);
      await supervisor.close();
      expect(supervisor.activeReservations).toBe(0);
      expect(
        (await readdir(path.join(directory, "process-scopes"))).filter((name) =>
          name.endsWith(".json"),
        ),
      ).toEqual([]);
      await settled;
    });

    it("preserves Unicode split between stdout chunks", async () => {
      const { directory, supervisor } = await setup();
      const result = await supervisor.run({
        executable: process.execPath,
        args: [
          "-e",
          'const b=Buffer.from("🦉 café");for(let i=0;i<b.length;i++)setTimeout(()=>process.stdout.write(b.subarray(i,i+1)),i*10)',
        ],
        cwd: directory,
        processLimit: 2,
      });
      expect(result.stdout).toBe("🦉 café");
    });
    it("preserves argument boundaries, stdin, and output", async () => {
      const { directory, supervisor } = await setup();
      const result = await supervisor.run({
        executable: process.execPath,
        args: [
          "-e",
          'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>console.log(JSON.stringify({args:process.argv.slice(1),input:s})))',
          "a b",
          'literal"quote',
          "trailing\\",
        ],
        cwd: directory,
        input: "hello\n",
        processLimit: 3,
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        args: ["a b", 'literal"quote', "trailing\\"],
        input: "hello\n",
      });
      expect(supervisor.activeReservations).toBe(0);
    });

    it("bounds concurrent process scopes before spawning", async () => {
      const { directory, supervisor } = await setup(1);
      let maximum = 0;
      await Promise.all(
        Array.from({ length: 8 }, () =>
          supervisor.run({
            executable: process.execPath,
            args: ["-e", 'console.log("started");setTimeout(()=>{},60)'],
            cwd: directory,
            processLimit: 3,
            onLine: () => {
              maximum = Math.max(maximum, supervisor.activeReservations);
            },
          }),
        ),
      );
      expect(maximum).toBe(1);
      expect(supervisor.activeReservations).toBe(0);
      // Eight serial scopes include startup and a 500 ms POSIX cleanup grace each.
    }, 20000);

    it("stops descendants on cancellation and after the direct child exits", async () => {
      const { directory, supervisor } = await setup();
      const pidFile = path.join(directory, "descendant.pid");
      const childCode = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
      const controller = new AbortController();
      const running = supervisor.run({
        executable: process.execPath,
        args: [
          "-e",
          `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});setInterval(()=>{},1000)`,
        ],
        cwd: directory,
        signal: controller.signal,
        processLimit: 4,
      });
      let pid = 0;
      for (let i = 0; i < 100 && !pid; i++) {
        pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
        if (!pid) await new Promise((resolve) => setTimeout(resolve, 30));
      }
      expect(pid).toBeGreaterThan(0);
      controller.abort();
      expect((await running).interrupted).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(supervisor.activeReservations).toBe(0);
    });

    it("bounds output without an unbounded line buffer", async () => {
      const { directory, supervisor } = await setup();
      const result = await supervisor.run({
        executable: process.execPath,
        args: [
          "-e",
          'process.stdout.write("x".repeat(1000000));setInterval(()=>{},1000)',
        ],
        cwd: directory,
        processLimit: 2,
        maxOutputBytes: 1024,
      });
      expect(result.outputLimited).toBe(true);
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024);
    });

    it.skipIf(process.platform !== "win32")(
      "enforces the descendant ceiling inside each scope",
      async () => {
        const { directory, supervisor } = await setup();
        const script = `let settled=0,started=0;for(let i=0;i<14;i++){try{const p=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});p.once('spawn',()=>{started++;end()});p.once('error',()=>end())}catch{end()}}function end(){if(++settled===14){console.log(started);process.exit(0)}}`;
        const result = await supervisor.run({
          executable: process.execPath,
          args: ["-e", script],
          cwd: directory,
          processLimit: 3,
        });
        expect(result.exitCode, result.stderr).toBe(0);
        expect(Number(result.stdout.trim())).toBeGreaterThan(0);
        expect(Number(result.stdout.trim())).toBeLessThanOrEqual(2);
      },
    );

    it("removes descendants when the engine exits and reconciles the durable scope on restart", async () => {
      const { directory, supervisor } = await setup();
      const fixture = fileURLToPath(
        new URL("./fixtures/process-owner.mjs", import.meta.url),
      );
      const owner = spawn(
        process.execPath,
        ["--import", "tsx", fixture, directory],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      const childPid = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Owner fixture timed out.")),
          10_000,
        );
        owner.stdout.once("data", (chunk) => {
          clearTimeout(timer);
          resolve(Number(String(chunk).trim()));
        });
        owner.once("error", reject);
      });
      expect(childPid).toBeGreaterThan(0);
      const exited = new Promise<void>((resolve) =>
        owner.once("close", () => resolve()),
      );
      owner.kill();
      await exited;
      const report = await supervisor.recover();
      expect(report.recovered).toBe(1);
      expect(() => process.kill(childPid, 0)).toThrow();
    });
  },
);
