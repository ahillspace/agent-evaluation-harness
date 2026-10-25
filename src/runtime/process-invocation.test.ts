import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { McpSession } from "./mcp-session.js";
import { ProcessSupervisor, type ProcessSpec } from "./process-supervisor.js";
import type { ProcessDriver } from "./processes/contracts.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(overrides: Partial<ProcessDriver> = {}) {
  const launched: string[] = [];
  const cleaned: string[] = [];
  const driver: ProcessDriver = {
    capabilities: { hardDescendantLimit: false },
    recover: async () => ({ recovered: 0 }),
    prepare: async () => {},
    launch: async (input) => {
      launched.push(input.id);
      const child = spawn(input.executable, input.args, {
        cwd: input.cwd,
        env: input.env,
        stdio: "pipe",
        windowsHide: true,
      });
      return { child, stop: () => child.kill() };
    },
    cleanup: async (id) => {
      cleaned.push(id);
    },
    ...overrides,
  };
  const supervisor = new ProcessSupervisor({
    driver,
    maxConcurrentInvocations: 1,
  });
  return { supervisor, launched, cleaned };
}

function spec(text = "done"): ProcessSpec {
  return {
    executable: process.execPath,
    args: ["-e", `console.log(${JSON.stringify(text)})`],
    cwd: process.cwd(),
    timeoutMs: 5000,
  };
}

it("owns a copied finite plan with one permit until explicit verified closure", async () => {
  const { supervisor, launched } = fixture();
  await supervisor.recover();
  try {
    const plan = [spec("first"), spec("second")];
    const invocation = await supervisor.acquireInvocation(plan);
    plan[0]!.args = ["-e", "process.exit(99)"];
    const results = await Promise.all([invocation.run(0), invocation.run(1)]);
    expect(results.map((result) => result.stdout.trim())).toEqual([
      "first",
      "second",
    ]);
    expect(supervisor.activeReservations).toBe(1);
    expect(launched).toHaveLength(2);
    await expect(invocation.run(0)).rejects.toThrow("not available");
    await expect(invocation.run(2)).rejects.toThrow("not available");
    await expect(invocation.close()).resolves.toBe("complete");
    expect(supervisor.activeReservations).toBe(0);
    await expect(invocation.run(1)).rejects.toThrow("closed");
    await expect(supervisor.run(spec("next"))).resolves.toMatchObject({
      stdout: "next\n",
    });
    await expect(supervisor.acquireInvocation([])).rejects.toThrow(
      "scope plan",
    );
    await expect(
      supervisor.acquireInvocation(Array.from({ length: 22 }, () => spec())),
    ).rejects.toThrow("scope plan");
    const maximum = await supervisor.acquireInvocation(
      Array.from({ length: 21 }, () => spec()),
    );
    await expect(maximum.close()).resolves.toBe("complete");
  } finally {
    await supervisor.close();
  }
});

it("holds admission through cleanup and cancels queued MCP work without a cleanup failure", async () => {
  const cleanupStarted = deferred();
  const allowCleanup = deferred();
  const { supervisor, launched } = fixture({
    cleanup: async () => {
      cleanupStarted.resolve();
      await allowCleanup.promise;
    },
  });
  await supervisor.recover();
  try {
    const first = supervisor.run(spec());
    await cleanupStarted.promise;
    const queued = new McpSession((interaction) =>
      supervisor.run({ ...spec(), ...interaction }),
    );
    const ready = expect(queued.ready).rejects.toThrow(
      "closed before its response",
    );
    await expect(queued.close()).resolves.toBeUndefined();
    await ready;
    expect(launched).toHaveLength(1);
    expect(supervisor.activeReservations).toBe(1);
    allowCleanup.resolve();
    await first;
    expect(supervisor.activeReservations).toBe(0);
    await expect(supervisor.run(spec("after"))).resolves.toMatchObject({
      stdout: "after\n",
    });
    expect(launched).toHaveLength(2);
  } finally {
    allowCleanup.resolve();
    await supervisor.close();
  }
});

it("drains prepared but unlaunched scopes during shutdown without poisoning cleanup", async () => {
  const preparing = deferred();
  const allowPreparation = deferred();
  const { supervisor, launched, cleaned } = fixture({
    prepare: async () => {
      preparing.resolve();
      await allowPreparation.promise;
    },
  });
  await supervisor.recover();
  const invocation = await supervisor.acquireInvocation([spec(), spec()]);
  const work = invocation.run(0);
  const rejected = expect(work).rejects.toMatchObject({ name: "AbortError" });
  await preparing.promise;
  const closing = supervisor.close();
  allowPreparation.resolve();
  await rejected;
  await closing;
  expect(launched).toEqual([]);
  expect(cleaned).toHaveLength(1);
  expect(supervisor.activeReservations).toBe(0);
  await expect(invocation.close()).resolves.toBe("complete");
});

it("retains one invocation permit and closes admissions when any native cleanup is unresolved", async () => {
  const { supervisor, launched } = fixture({
    cleanup: async () => {
      throw new Error("cleanup unavailable");
    },
  });
  await supervisor.recover();
  try {
    const invocation = await supervisor.acquireInvocation([spec(), spec()]);
    const results = await Promise.allSettled([
      invocation.run(0),
      invocation.run(1),
    ]);
    expect(results).toEqual([
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "cleanup_failed" }),
      }),
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "cleanup_failed" }),
      }),
    ]);
    expect(launched).toHaveLength(2);
    await expect(invocation.close()).resolves.toBe("unavailable");
    expect(supervisor.activeReservations).toBe(1);
    await expect(supervisor.run(spec())).rejects.toThrow("admission is closed");
    expect(launched).toHaveLength(2);
  } finally {
    await supervisor.close();
  }
});

it("closes an idle admitted invocation during shutdown", async () => {
  const { supervisor, launched } = fixture();
  await supervisor.recover();
  const invocation = await supervisor.acquireInvocation([spec()]);
  await supervisor.close();
  expect(invocation.signal.aborted).toBe(true);
  expect(launched).toEqual([]);
  expect(supervisor.activeReservations).toBe(0);
});
