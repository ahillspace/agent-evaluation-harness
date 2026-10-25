import { targetFixture } from "../fixtures/runtime-targets.js";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentConfig,
  BankRevision,
  Json,
  RunView,
  RuntimePort,
} from "../../src/contracts.js";
import { createApplication } from "../../src/application/application.js";
import { startServer } from "../../src/server.js";

const executeFile = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "aeh-transport-"));
  cleanups.push(() => rm(dataDirectory, { recursive: true, force: true }));
  let site = "original-site";
  let executions = 0;
  const runtime: RuntimePort = {
    recover: async () => ({ recovered: [], errors: [] }),
    close: async () => {},
    discover: async () => ({
      harnesses: [],
      connectionProviders: [],
      maxConcurrency: 1,
    }),
    listConnections: async () => [],
    saveConnection: async () => {
      throw new Error("Unused test operation");
    },
    deleteConnection: async () => {},
    testConnection: async () => ({ ok: true, message: "Test connection" }),
    ...targetFixture,
    resolveAgent: async (agent) => ({
      ...structuredClone(agent),
      connections: agent.connections.map((binding) => ({
        ...binding,
        settings: { site },
        credentialFields: ["token"],
      })),
    }),
    execute: async (input) => {
      expect(input.question).not.toHaveProperty("expected");
      executions++;
      input.onEvent({
        type: "tool.started",
        message: "Fixture query started.",
      });
      return {
        answer: 42,
        text: "42",
        usage: { inputTokens: 12, outputTokens: 3 },
      };
    },
    judge: async () => {
      throw new Error("A disabled judge must not run");
    },
    researcher: async () => {
      throw new Error("Unused test operation");
    },
  };
  const application = await createApplication({ dataDirectory, runtime });
  const server = await startServer({ application, port: 0, host: "127.0.0.1" });
  cleanups.push(() => server.close());
  async function request(operation: string, input: unknown) {
    const response = await fetch(`${server.url}/api/commands/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return { response, body: (await response.json()) as unknown };
  }
  async function cli(operation: string, input: unknown) {
    const output = await executeFile(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("src/cli.ts"),
        operation,
        "--url",
        server.url,
        "--json",
        JSON.stringify(input),
      ],
      { windowsHide: true, timeout: 15_000 },
    );
    return JSON.parse(output.stdout) as unknown;
  }
  return {
    dataDirectory,
    application,
    server,
    request,
    cli,
    executions: () => executions,
    editConnection: () => {
      site = "edited-site";
    },
  };
}

it("rejects stale and uncalibrated bank revisions across independent HTTP editors", async () => {
  const { request } = await fixture();
  const created = await request("banks.create", {
    name: "Two editors",
    questions: [{ id: "q1", text: "Count?", expected: 42 }],
    evaluator: {
      calibrationExamples: [
        {
          id: "known",
          questionId: "q1",
          answer: 42,
          expectedStatus: "correct",
        },
      ],
    },
  });
  expect(created.response.ok).toBe(true);
  const revision = created.body as BankRevision;
  const [firstRead, secondRead] = await Promise.all([
    request("banks.get", { bankId: revision.bankId }),
    request("banks.get", { bankId: revision.bankId }),
  ]);
  const first = firstRead.body as import("../../src/contracts.js").BankDetail;
  const second = secondRead.body as import("../../src/contracts.js").BankDetail;
  const input = (detail: typeof first) => ({
    bankId: revision.bankId,
    baseRevisionId: detail.bank.latestRevisionId,
    baseEvaluatorRevisionId: detail.bank.activeEvaluatorRevisionId,
    name: "Edited bank",
    questions: revision.questions,
  });
  const saved = await request("banks.revise", input(first));
  expect(saved.response.ok).toBe(true);
  const stale = await request("banks.revise", {
    ...input(second),
    name: "Stale overwrite",
  });
  expect(stale.response.ok).toBe(false);
  expect(stale.body).toMatchObject({ error: { code: "conflict" } });
  const latest = (await request("banks.get", { bankId: revision.bankId }))
    .body as typeof first;
  const invalid = await request("banks.revise", {
    ...input(latest),
    questions: [{ ...revision.questions[0]!, expected: 0 }],
  });
  expect(invalid.response.ok).toBe(false);
  expect(invalid.body).toMatchObject({ error: { code: "calibration_failed" } });
  expect(
    (await request("banks.get", { bankId: revision.bankId })).body,
  ).toEqual(latest);
});

const agent: AgentConfig = {
  harness: "codex",
  model: "fixture-model",
  systemPrompt: "Use approved tools and return the answer.",
  settings: { temperature: 0.2, maxTurns: 6 },
  tools: ["query-datasource"],
  connections: [
    {
      connectionId: "fixture-connection",
      provider: "tableau",
      settings: {},
      credentialFields: [],
    },
  ],
};

describe("agent and browser application parity", () => {
  it("accepts UTF-8 BOM JSON from Windows files and HTTP clients", async () => {
    const app = await fixture();
    const path = join(app.dataDirectory, "windows-input.json");
    await writeFile(path, "\uFEFF{}", "utf8");
    const output = await executeFile(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("src/cli.ts"),
        "workspace.get",
        "--url",
        app.server.url,
        "--file",
        path,
      ],
      { windowsHide: true, timeout: 15_000 },
    );
    expect(JSON.parse(output.stdout)).toHaveProperty("banks");
    const response = await fetch(
      `${app.server.url}/api/commands/workspace.get`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "\uFEFF{}",
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("banks");
  });
  it("grades a natural JSON answer against typed expectations without exposing gold", async () => {
    const app = await fixture();
    const created = await app.request("banks.create", {
      name: "Typed answer acceptance",
      questions: [
        {
          id: "q1",
          text: "What is six times seven?",
          expected: { type: "numeric", value: 42 },
        },
      ],
    });
    const bank = created.body as BankRevision;
    const launched = await app.request("runs.launch", {
      bankRevisionId: bank.id,
      agent,
    });
    const runId = (launched.body as RunView).run.id;
    await app.application.waitForIdle();
    const finished = (await app.request("runs.get", { runId })).body as RunView;
    expect(finished.scoreSets[0]?.assessments[0]?.deterministic.status).toBe(
      "correct",
    );
    expect(app.executions()).toBe(1);
  });
  it("launches once across HTTP and CLI and exports the exact frozen agent", async () => {
    const app = await fixture();
    const created = await app.request("banks.create", {
      name: "Transport acceptance",
      questions: [{ id: "q1", text: "Return the count.", expected: 42 }],
    });
    expect(created.response.ok).toBe(true);
    const bank = created.body as BankRevision;
    const input = {
      bankRevisionId: bank.id,
      agent,
      repetitions: 2,
      idempotencyKey: "transport-acceptance",
    };
    const launched = await app.request("runs.launch", input);
    expect(launched.response.ok).toBe(true);
    const first = launched.body as RunView;
    const repeated = (await app.cli("runs.launch", input)) as RunView;
    expect(repeated.run.id).toBe(first.run.id);
    await app.application.waitForIdle();
    const saved = (await app.cli("runs.get", {
      runId: first.run.id,
    })) as RunView;
    expect(saved.run.status).toBe("completed");
    expect(saved.results).toHaveLength(2);
    expect(app.executions()).toBe(2);
    app.editConnection();
    const exported = (await app.cli("runs.export-agent", {
      runId: first.run.id,
    })) as {
      agent: AgentConfig & {
        connections: Array<{
          credentials: Record<string, string>;
          settings: Record<string, Json>;
        }>;
      };
    };
    expect(exported.agent.systemPrompt).toBe(agent.systemPrompt);
    expect(exported.agent.settings).toEqual(agent.settings);
    expect(exported.agent.tools).toEqual(agent.tools);
    expect(exported.agent.connections[0]?.settings.site).toBe("original-site");
    expect(exported.agent.connections[0]?.credentials.token).toContain("${");
    expect(JSON.stringify(exported)).not.toContain("expected");
    const conflict = await app.request("runs.launch", {
      ...input,
      repetitions: 3,
    });
    expect(conflict.response.ok).toBe(false);
    expect(conflict.body).toHaveProperty("error.code");
  }, 30_000);

  it("returns machine-readable validation failures and rejects foreign browser origins", async () => {
    const app = await fixture();
    const invalid = await app.request("runs.launch", { agent });
    expect(invalid.response.status).toBeGreaterThanOrEqual(400);
    expect(invalid.body).toHaveProperty("error.code");
    const foreign = await fetch(`${app.server.url}/api/commands/banks.create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://untrusted.invalid",
      },
      body: JSON.stringify({
        name: "Must not be created",
        questions: [{ id: "q", text: "q", expected: 1 }],
      }),
    });
    expect(foreign.status).toBe(403);
  });
});
