import { expect, it, vi } from "vitest";
import { TargetRegistry } from "./registry.js";
import { externalCapabilities } from "../../contracts/targets.js";
import type { TargetAdapter } from "./contracts.js";

it("registers an internal session adapter with shared invocation and recovery", async () => {
  const actions: string[] = [];
  const adapter: TargetAdapter = {
    id: "session-fixture",
    version: 1,
    capabilities: externalCapabilities,
    validate: (target) => target,
    resolve: async (target) => target,
    async invoke(input) {
      await input.checkpoint({ session: "fixture" });
      actions.push("create", "invoke", "cleanup");
      return {
        answer: 42,
        text: "42",
        evidenceScope: "answer-only",
        cleanup: "complete",
      };
    },
    async recover(input) {
      expect(input.target).toMatchObject({ adapterId: "session-fixture" });
      expect(input.checkpoint).toEqual({ session: "fixture" });
      expect(input.timeoutMs).toBeGreaterThan(0);
      expect(input.signal.aborted).toBe(false);
      actions.push("recover");
      return { cleanup: "complete", remoteCompletion: "unknown" };
    },
    async close() {},
  };
  const registry = new TargetRegistry([adapter], 1);
  const target = {
    kind: "external" as const,
    adapterId: adapter.id,
    adapterVersion: 1,
    name: "Fixture",
    configuration: {},
  };
  expect((await registry.resolve(target)).capabilities).toEqual(
    externalCapabilities,
  );
  const saved: unknown[] = [];
  const output = await registry.invoke({
    target,
    attemptId: "a",
    runId: "r",
    repetition: 1,
    question: { id: "q", text: "Question", tags: [] },
    artifactDirectory: "unused",
    timeoutMs: 1000,
    maxOutputBytes: 10000,
    signal: new AbortController().signal,
    onEvent() {},
    async checkpoint(value) {
      saved.push(value);
    },
  });
  expect(output.answer).toBe(42);
  await registry.recover(target, { session: "fixture" });
  expect(actions).toEqual(["create", "invoke", "cleanup", "recover"]);
  expect(saved).toEqual([{ session: "fixture" }]);
  await registry.close();
});

it.each(["returned", "thrown"])(
  "blocks further admission after %s cleanup failure without erasing answers",
  async (mode) => {
    let calls = 0;
    const adapter: TargetAdapter = {
      id: "session",
      version: 1,
      capabilities: externalCapabilities,
      validate: (target) => target,
      resolve: async (target) => target,
      async invoke() {
        calls++;
        if (mode === "thrown")
          throw Object.assign(new Error("Cleanup failed"), {
            code: "cleanup_failed",
          });
        return {
          answer: 42,
          text: "42",
          cleanup: "unavailable",
          evidenceScope: "answer-only",
        };
      },
      recover: async () => ({
        cleanup: "complete",
        remoteCompletion: "unknown",
      }),
      close: async () => {},
    };
    const registry = new TargetRegistry([adapter], 1);
    const invocation = {
      target: {
        kind: "external" as const,
        adapterId: "session",
        adapterVersion: 1,
        name: "Session",
        configuration: {},
      },
      attemptId: "a",
      runId: "r",
      repetition: 1,
      question: { id: "q", text: "Question", tags: [] },
      artifactDirectory: "unused",
      timeoutMs: 1000,
      maxOutputBytes: 10000,
      signal: new AbortController().signal,
      onEvent() {},
      async checkpoint() {},
    };
    if (mode === "returned")
      expect((await registry.invoke(invocation)).answer).toBe(42);
    else
      await expect(registry.invoke(invocation)).rejects.toMatchObject({
        code: "cleanup_failed",
      });
    await expect(registry.invoke(invocation)).rejects.toMatchObject({
      code: "cleanup_failed",
    });
    expect(calls).toBe(1);
    await registry.close();
  },
);

it("bounds stalled recovery and blocks subsequent target admission", async () => {
  let recoverySignal: AbortSignal | undefined;
  const adapter: TargetAdapter = {
    id: "session",
    version: 1,
    capabilities: externalCapabilities,
    validate: (target) => target,
    resolve: async (target) => target,
    invoke: async () => ({
      answer: 42,
      text: "42",
      evidenceScope: "answer-only",
      cleanup: "complete",
    }),
    recover: async (input) => {
      recoverySignal = input.signal;
      return new Promise(() => {});
    },
    close: async () => {},
  };
  const registry = new TargetRegistry([adapter], 1, 20);
  const target = {
    kind: "external" as const,
    adapterId: "session",
    adapterVersion: 1,
    name: "Session",
    configuration: {},
  };
  await expect(
    registry.recover(target, { session: "pending" }),
  ).rejects.toMatchObject({ code: "cleanup_failed" });
  expect(recoverySignal?.aborted).toBe(true);
  await expect(
    registry.invoke({
      target,
      attemptId: "a",
      runId: "r",
      repetition: 1,
      question: { id: "q", text: "Question", tags: [] },
      artifactDirectory: "unused",
      timeoutMs: 1000,
      maxOutputBytes: 1000,
      signal: new AbortController().signal,
      onEvent() {},
      async checkpoint() {},
    }),
  ).rejects.toMatchObject({ code: "cleanup_failed" });
  await registry.close();
});

it("owns and clears the recovery deadline after cleanup settles", async () => {
  const start = vi.spyOn(globalThis, "setTimeout");
  const clear = vi.spyOn(globalThis, "clearTimeout");
  try {
    const adapter: TargetAdapter = {
      id: "session",
      version: 1,
      capabilities: externalCapabilities,
      validate: (target) => target,
      resolve: async (target) => target,
      invoke: async () => ({
        answer: 42,
        text: "42",
        evidenceScope: "answer-only",
        cleanup: "complete",
      }),
      recover: async () => ({
        cleanup: "complete",
        remoteCompletion: "unknown",
      }),
      close: async () => {},
    };
    const registry = new TargetRegistry([adapter], 1, 1000);
    await registry.recover(
      {
        kind: "external",
        adapterId: "session",
        adapterVersion: 1,
        name: "Session",
        configuration: {},
      },
      {},
    );
    expect(start).toHaveBeenCalledWith(expect.any(Function), 1000);
    expect(clear).toHaveBeenCalledWith(start.mock.results[0]?.value);
    await registry.close();
  } finally {
    start.mockRestore();
    clear.mockRestore();
  }
});

it("rejects mismatched evidence scope without making unsafe capacity available", async () => {
  let calls = 0;
  const adapter: TargetAdapter = {
    id: "session",
    version: 1,
    capabilities: externalCapabilities,
    validate: (target) => target,
    resolve: async (target) => target,
    invoke: async () => {
      calls++;
      return {
        answer: 42,
        text: "42",
        evidenceScope: "internal-activity",
        cleanup: "unavailable",
      };
    },
    recover: async () => ({ cleanup: "complete", remoteCompletion: "unknown" }),
    close: async () => {},
  };
  const registry = new TargetRegistry([adapter], 1);
  const target = {
    kind: "external" as const,
    adapterId: "session",
    adapterVersion: 1,
    name: "Session",
    configuration: {},
  };
  const input = {
    target,
    attemptId: "a",
    runId: "r",
    repetition: 1,
    question: { id: "q", text: "Question", tags: [] },
    artifactDirectory: "unused",
    timeoutMs: 1000,
    maxOutputBytes: 1000,
    signal: new AbortController().signal,
    onEvent() {},
    async checkpoint() {},
  };
  await expect(registry.invoke(input)).rejects.toMatchObject({
    code: "cleanup_failed",
  });
  await expect(registry.invoke(input)).rejects.toMatchObject({
    code: "cleanup_failed",
  });
  expect(calls).toBe(1);
  await registry.close();
});
