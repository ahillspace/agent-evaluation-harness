import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ProcessSupervisor, type ProcessSpec } from "./process-supervisor.js";
import { agentSchema, judgeSchema } from "../contracts.js";

const fixture = vi.hoisted(() => ({
  run: undefined as undefined | ((spec: ProcessSpec) => Promise<unknown>),
}));
vi.mock("./platform.js", () => ({
  createPlatformServices: () => {
    const secrets = new Map<string, string>();
    return {
      initialize: async () => {},
      supervisor: {
        recover: async () => ({ recovered: 0 }),
        close: async () => {},
        run: (spec: ProcessSpec) => fixture.run!(spec),
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

it.each(["timeout", "interruption", "output-limit", "deadline"])(
  "preserves partial judge evidence and usage after a real supervised %s",
  async (mode) => {
    const directory = await mkdtemp(path.join(tmpdir(), "aeh-judge-partial-"));
    const controller = new AbortController();
    const secret = "fixture-partial-secret";
    const events = [
      {
        type: "item.completed",
        item: { type: "agent_message", text: `Partial response ${secret}` },
      },
      {
        type: "turn.completed",
        usage: { input_tokens: 17, output_tokens: 5, cached_input_tokens: 0 },
      },
    ];
    const script =
      events
        .map(
          (event) => `console.log(${JSON.stringify(JSON.stringify(event))});`,
        )
        .join("") +
      (mode === "output-limit"
        ? "setTimeout(()=>process.stdout.write('x'.repeat(10000)),50);"
        : "setInterval(()=>{},1000);");
    const supervisor = new ProcessSupervisor({
      driver: {
        capabilities: { hardDescendantLimit: false },
        recover: async () => ({ recovered: 0 }),
        prepare: async () => {},
        cleanup: async () => {},
        launch: async (input) => {
          const child = spawn(input.executable, input.args, {
            cwd: input.cwd,
            env: input.env,
            stdio: "pipe",
            windowsHide: true,
          });
          return {
            child,
            stop: () => {
              child.kill();
            },
          };
        },
      },
    });
    await supervisor.recover();
    fixture.run = (spec) =>
      supervisor.run({
        ...spec,
        executable: process.execPath,
        args: ["-e", script],
        timeoutMs: mode === "timeout" ? 500 : 5000,
        maxOutputBytes: 2000,
        onLine: (line, write) => {
          spec.onLine?.(line, write);
          if (mode === "interruption" && line.includes("turn.completed"))
            controller.abort();
        },
      });
    const runtime = createRuntime({ stateDirectory: directory });
    try {
      const connection = await runtime.saveConnection({
        name: "Fixture provider",
        provider: "openai",
        settings: {},
        credentials: { apiKey: secret },
      });
      const agent = await runtime.resolveAgent(
        agentSchema.parse({
          harness: "codex",
          model: "fixture",
          connections: [
            {
              connectionId: connection.id,
              provider: "openai",
              credentialFields: ["apiKey"],
            },
          ],
        }),
      );
      await expect(
        runtime.judge({
          configuration: judgeSchema.parse({ enabled: true, agent }),
          evidence: {
            schemaVersion: 1,
            runId: "run",
            resultId: "result",
            attemptId: "attempt",
            repetition: 1,
            question: { id: "q", text: "Count", tags: [] },
            expected: 42,
            finalAnswer: 42,
            finalText: "42",
            referenceCriteria: {},
            startedAt: "2026-01-01",
            finishedAt: "2026-01-01",
            observationLevel: "answer-only",
            trace: { format: "unavailable", entries: null },
          },
          artifactDirectory: directory,
          timeoutMs: mode === "deadline" ? 1000 : 5000,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({
        invocation: {
          usage: { inputTokens: 17, outputTokens: 5 },
          response: {
            text: "Partial response [REDACTED]",
            transcript: expect.any(Array),
          },
        },
      });
      const artifact = await readFile(
        path.join(directory, "invocation.json"),
        "utf8",
      );
      expect(artifact).not.toContain(secret);
      expect(JSON.parse(artifact).response.transcript).toHaveLength(2);
      expect(supervisor.activeReservations).toBe(0);
    } finally {
      await runtime.close();
      await supervisor.close();
      fixture.run = undefined;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
