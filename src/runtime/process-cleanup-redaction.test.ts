import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import {
  ProcessCleanupFailure,
  ProcessSupervisor,
  type ProcessSpec,
} from "./process-supervisor.js";

const fixture = vi.hoisted(() => ({
  cleanupFailure: undefined as unknown,
  runCalls: 0,
  run: undefined as undefined | ((spec: ProcessSpec) => Promise<unknown>),
}));

vi.mock("./platform.js", () => ({
  createPlatformServices: () => {
    const secrets = new Map<string, string>();
    return {
      initialize: async () => undefined,
      supervisor: {
        recover: async () => ({ recovered: 0 }),
        run: async (spec: ProcessSpec) => {
          fixture.runCalls++;
          if (fixture.run) return fixture.run(spec);
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
  fixture.run = undefined;
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it.each(["generic", "watchdog125", "watchdog125-settled"])(
  "redacts %s execution failures at the runtime boundary",
  async (mode) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "aeh-cleanup-redaction-"),
    );
    directories.push(directory);
    const secret = "fixture-provider-secret";
    const originalError = new Error(`Provider failed with ${secret}`, {
      cause: new Error(`Nested ${secret}`),
    });
    fixture.cleanupFailure = new ProcessCleanupFailure({
      cause: originalError,
    });
    let supervisor: ProcessSupervisor | undefined;
    if (mode.startsWith("watchdog125")) {
      supervisor = new ProcessSupervisor({
        driver: {
          capabilities: { hardDescendantLimit: false },
          prepare: async () => {},
          recover: async () => ({ recovered: 0 }),
          launch: async (input) => {
            const event = {
              type: "error",
              sessionID: "session",
              error: {
                name: "AI_APICallError",
                message: `Provider failed with ${secret}`,
                data: { code: "model_not_found", statusCode: 404 },
              },
            };
            const child = spawn(
              process.execPath,
              [
                "-e",
                `console.log(${JSON.stringify(JSON.stringify(event))});console.error('Containment: ${secret}');process.exitCode=125;`,
              ],
              { cwd: input.cwd, env: input.env, stdio: "pipe" },
            );
            return { child, stop: () => child.kill() };
          },
          cleanup: async () => {
            if (mode !== "watchdog125-settled")
              throw new Error(`Cleanup ${secret}`);
          },
        },
      });
      await supervisor.recover();
      fixture.run = (spec) => supervisor!.run(spec);
    }
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
      expect(inspect(caught, { depth: 10, showHidden: true })).not.toContain(
        secret,
      );
      expect((caught as Error).stack).not.toContain(secret);
      expect(JSON.stringify((caught as Error).cause) ?? "").not.toContain(
        secret,
      );
      expect(
        (caught as ProcessCleanupFailure).takeProcessResult(),
      ).toBeUndefined();
      expect(
        (caught as ProcessCleanupFailure).takeOriginalError(),
      ).toBeUndefined();
      if (mode.startsWith("watchdog125"))
        expect(caught).toMatchObject({
          evidence: { providerCode: "model_not_found", statusCode: 404 },
        });
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
      await supervisor?.close();
    }
  },
);
