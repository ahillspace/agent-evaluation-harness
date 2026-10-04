import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { RuntimePort, TargetConfig } from "../contracts.js";
import { TargetInvocations } from "./target-invocations.js";
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const target: TargetConfig = {
  kind: "external",
  adapterId: "session-fixture",
  adapterVersion: 1,
  name: "Fixture",
  configuration: { endpoint: "https://example.com" },
};
async function fixture(cleanup: "complete" | "unavailable" = "complete") {
  const directory = await mkdtemp(join(tmpdir(), "aeh-invocations-"));
  directories.push(directory);
  const runtime = {
    execute: vi.fn(async (input: Parameters<RuntimePort["execute"]>[0]) => {
      await input.checkpoint({ session: "s" });
      return {
        answer: 42,
        text: "42",
        cleanup,
        evidenceScope: "answer-only" as const,
      };
    }),
    recoverTarget: vi.fn(async () => ({
      cleanup: "complete" as const,
      remoteCompletion: "unknown" as const,
    })),
  };
  const invocations = new TargetInvocations(directory, runtime);
  const input: Parameters<RuntimePort["execute"]>[0] = {
    target,
    attemptId: "sample_1",
    runId: "sample",
    repetition: 1,
    question: { id: "q", text: "Answer", tags: [] },
    artifactDirectory: directory,
    timeoutMs: 1000,
    maxOutputBytes: 1024,
    signal: new AbortController().signal,
    onEvent() {},
    checkpoint: vi.fn(async () => {}),
  };
  return { directory, runtime, invocations, input };
}
it("clears the durable checkpoint only after confirmed cleanup", async () => {
  const f = await fixture();
  await f.invocations.execute(f.input);
  expect(f.input.checkpoint).toHaveBeenCalledWith({ session: "s" });
  expect(await readdir(join(f.directory, "target-invocations"))).toEqual([]);
});
it("recovers a sample or completed answer with unresolved resources without resending", async () => {
  const f = await fixture("unavailable");
  await f.invocations.execute(f.input);
  const recovered = await new TargetInvocations(
    f.directory,
    f.runtime,
  ).recover();
  expect(recovered.get("sample_1")?.remoteCompletion).toBe("unknown");
  expect(f.runtime.recoverTarget).toHaveBeenCalledWith(target, {
    session: "s",
  });
  expect(f.runtime.execute).toHaveBeenCalledTimes(1);
  expect(await readdir(join(f.directory, "target-invocations"))).toEqual([]);
});
it("retains recovery intent when cleanup cannot be confirmed", async () => {
  const f = await fixture("unavailable");
  await f.invocations.execute(f.input);
  f.runtime.recoverTarget.mockRejectedValueOnce(
    new Error("cleanup unavailable"),
  );
  await expect(f.invocations.recover()).rejects.toThrow("cleanup unavailable");
  expect(await readdir(join(f.directory, "target-invocations"))).toEqual([
    "sample_1.json",
  ]);
});
it("retains checkpoints when cleanup fails", async () => {
  const f = await fixture();
  f.runtime.execute.mockImplementationOnce(async (input) => {
    await input.checkpoint({ session: "s" });
    throw Object.assign(new Error("interrupted"), { code: "cleanup_failed" });
  });
  await expect(f.invocations.execute(f.input)).rejects.toThrow("interrupted");
  await f.invocations.recover();
  expect(f.runtime.recoverTarget).toHaveBeenCalledTimes(1);
});

it("settles resource intent after a rejection that guarantees cleanup", async () => {
  const f = await fixture();
  f.runtime.execute.mockImplementationOnce(async (input) => {
    await input.checkpoint({ session: "s" });
    throw new Error("transport failed after cleanup");
  });
  await expect(f.invocations.execute(f.input)).rejects.toThrow(
    "transport failed",
  );
  expect(await readdir(join(f.directory, "target-invocations"))).toEqual([]);
});
