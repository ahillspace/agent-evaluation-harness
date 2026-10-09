import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ProcessCleanupFailure } from "./process-supervisor.js";

const fixture = vi.hoisted(() => ({
  cleanupFailure: undefined as unknown,
  runCalls: 0,
}));

vi.mock("./platform.js", () => ({
  createPlatformServices: () => {
    const secrets = new Map<string, string>();
    return {
      initialize: async () => undefined,
      supervisor: {
        recover: async () => ({ recovered: 0 }),
        run: async () => {
          fixture.runCalls++;
          throw fixture.cleanupFailure;
        },
        close: async () => undefined,
      },
      secrets: {
        allocate: async () => randomUUID(),
        owns: async (id: string) => secrets.has(id),
        read: async (id: string) => secrets.get(id),
        write: async (id: string, value: string) => {
          secrets.set(id, value);
        },
        delete: async (id: string) => {
          secrets.delete(id);
        },
      },
    };
  },
}));

import { createRuntime } from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  fixture.cleanupFailure = undefined;
  fixture.runCalls = 0;
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("redacts generic execution causes when cleanup fails at the runtime boundary", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "aeh-cleanup-redaction-"),
  );
  directories.push(directory);
  const secret = "fixture-provider-secret";
  const originalError = new Error(`Provider failed with ${secret}`);
  fixture.cleanupFailure = new ProcessCleanupFailure({ cause: originalError });
  const runtime = createRuntime({ stateDirectory: directory });
  try {
    const connection = await runtime.saveConnection({
      name: "Provider",
      provider: "openai",
      settings: {},
      credentials: { apiKey: secret },
    });
    const resolved = await runtime.resolveTarget({
      kind: "managed",
      agent: {
        harness: "opencode",
        model: "openai/test-model",
        systemPrompt: "Answer the question.",
        settings: {},
        tools: [],
        connections: [
          {
            connectionId: connection.id,
            provider: "openai",
            settings: {},
            credentialFields: ["apiKey"],
          },
        ],
      },
    });
    let caught: unknown;
    try {
      await runtime.execute({
        attemptId: "attempt",
        target: resolved.target,
        runId: "run",
        repetition: 1,
        question: { id: "q", text: "Question", tags: [] },
        artifactDirectory: directory,
        timeoutMs: 5000,
        maxOutputBytes: 10_000,
        signal: new AbortController().signal,
        onEvent: () => {},
        checkpoint: async () => {},
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProcessCleanupFailure);
    expect(caught).toMatchObject({
      code: "cleanup_failed",
      message: expect.stringContaining("[REDACTED]"),
      evidence: { message: expect.stringContaining("[REDACTED]") },
    });
    expect((caught as Error).message).not.toContain(secret);
    expect(JSON.stringify(caught)).not.toContain(secret);
    await expect(
      runtime.execute({
        attemptId: "attempt-2",
        target: resolved.target,
        runId: "run",
        repetition: 1,
        question: { id: "q", text: "Question", tags: [] },
        artifactDirectory: directory,
        timeoutMs: 5000,
        maxOutputBytes: 10_000,
        signal: new AbortController().signal,
        onEvent: () => {},
        checkpoint: async () => {},
      }),
    ).rejects.toMatchObject({ code: "cleanup_failed" });
    expect(fixture.runCalls).toBe(1);
  } finally {
    await runtime.close();
  }
});
