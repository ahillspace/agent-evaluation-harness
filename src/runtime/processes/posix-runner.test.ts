import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { processEntry } from "./entry.js";

it("retains the group leader after its target exits until the watchdog cleans it", async () => {
  const runner = spawn(process.execPath, processEntry("posix-runner").args, {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  const exited = once(runner, "exit");
  try {
    const [ready] = await once(runner, "message");
    expect(ready).toMatchObject({ type: "ready" });
    const completed = once(runner, "message");
    runner.send({
      type: "launch",
      input: {
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: process.cwd(),
        env: process.env,
      },
    });
    runner.stdin!.end();
    expect((await completed)[0]).toMatchObject({ type: "exit", code: 0 });
    // Delay the watchdog deliberately: ownership must survive asynchronous verification.
    await delay(200);
    expect(runner.exitCode).toBeNull();
    expect(runner.signalCode).toBeNull();
    expect(runner.connected).toBe(true);
  } finally {
    runner.kill("SIGKILL");
    await exited;
  }
});
