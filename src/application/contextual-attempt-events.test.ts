import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  agentSchema,
  type ObservationEvent,
  type RuntimePort,
} from "../contracts.js";
import { Database } from "../storage/database.js";
import { digest } from "../domain/identity.js";
import { createApplication } from "./application.js";
import { startServer } from "../server.js";
import { runCli } from "../cli.js";
import { targetFixture } from "../../tests/fixtures/runtime-targets.js";
import { recordHistoricalRetry } from "../../tests/fixtures/historical-retry.js";

it("returns adopted physical plus requested logical activity through one authorized HTTP and CLI cursor without changing evidence or audit ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeh-contextual-events-"));
  let targets = 0,
    judges = 0;
  const runtime: RuntimePort = {
    ...targetFixture,
    resolveAgent: async (agent) => agent,
    discover: async () => {
      throw Error("Unexpected discovery");
    },
    recover: async () => ({ recovered: [], errors: [] }),
    close: async () => {},
    listConnections: async () => [],
    saveConnection: async () => {
      throw Error("Unused");
    },
    deleteConnection: async () => {},
    testConnection: async () => ({ ok: true, message: "Fixture" }),
    execute: async ({ onEvent }) => {
      if (++targets === 1) throw Error("Original synthetic failure");
      onEvent({
        type: "agent.message",
        message: "Physical runtime event",
        data: { full: "retained" },
      });
      return { answer: 42, text: "42", evidenceScope: "internal-activity" };
    },
    judge: async ({ evidence }) => {
      judges++;
      expect(evidence.trace.format).toBe("recorded_events");
      expect(JSON.stringify(evidence.trace)).not.toContain("LOGICAL_CONTEXT");
      expect(JSON.stringify(evidence.trace)).not.toContain("SIBLING_CONTEXT");
      return {
        verdict: true,
        explanation: "Synthetic saved judge",
        usage: { inputTokens: 7, outputTokens: 2, costUsd: 0 },
      };
    },
    researcher: async () => {
      throw Error("Unexpected researcher");
    },
  };
  let app = await createApplication({ dataDirectory: directory, runtime });
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let reader: DatabaseSync | undefined;
  try {
    const agent = agentSchema.parse({ harness: "codex", model: "fixture" });
    const bank = await app.execute("banks.create", {
      name: "Contextual activity",
      questions: [{ id: "q", text: "Answer?", expected: 42 }],
    });
    const launch = async () => {
      const result = await app.execute("runs.launch", {
        bankRevisionId: bank.id,
        agent,
      });
      await app.waitForIdle();
      return app.execute("runs.get", { runId: result.run.id });
    };
    const parent = await launch(),
      child = await launch(),
      sibling = await launch();
    const attemptId = child.results[0]!.completedAttemptId!;
    await app.close();
    const db = new Database(join(directory, "workspace.sqlite"));
    try {
      recordHistoricalRetry(db, parent.run.id, child.run.id, [
        parent.results[0]!.id,
      ]);
      db.transaction(() => {
        for (let index = 0; index < 121; index++) {
          db.append({
            runId: child.run.id,
            attemptId,
            type: "agent.message",
            message: `PHYSICAL_CONTEXT-${index}:` + "full".repeat(300),
            data: { index, physical: true },
          });
          db.append({
            runId: parent.run.id,
            attemptId,
            type: "agent.message",
            message: `LOGICAL_CONTEXT-${index}:` + "full".repeat(300),
            data: { index, logical: true },
          });
          db.append({
            runId: sibling.run.id,
            attemptId,
            type: "judge.started",
            message: `SIBLING_CONTEXT-${index}`,
            data: { excluded: true },
          });
          db.append({
            runId: child.run.id,
            attemptId: sibling.results[0]!.completedAttemptId!,
            type: "agent.message",
            message: "Excluded other attempt",
          });
        }
      });
    } finally {
      db.close();
    }
    app = await createApplication({ dataDirectory: directory, runtime });
    server = await startServer({ application: app, port: 0 });
    reader = new DatabaseSync(join(directory, "workspace.sqlite"), {
      readOnly: true,
    });
    const state = () =>
      JSON.stringify({
        records: reader!
          .prepare("SELECT kind,id,value FROM records ORDER BY ordinal")
          .all(),
        events: reader!.prepare("SELECT * FROM events ORDER BY sequence").all(),
      });
    const physicalBytes = () =>
      String(
        reader!
          .prepare("SELECT value FROM records WHERE kind='attempt' AND id=?")
          .get(attemptId)!.value,
      );
    const beforePhysical = physicalBytes();
    const post = (operation: string, input: unknown) =>
      fetch(`${server!.url}/api/commands/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    const passResponse = await post("runs.assess", {
      runId: parent.run.id,
      source: "llm",
      name: "Logical parent saved judge",
      judge: { enabled: true, agent },
    });
    expect(passResponse.status).toBe(200);
    const pass = await passResponse.json();
    expect(pass.runId).toBe(parent.run.id);
    expect(pass.judgments[0]).toMatchObject({
      attemptId,
      usage: { inputTokens: 7, outputTokens: 2, costUsd: 0 },
    });
    expect(physicalBytes()).toBe(beforePhysical);
    const judged = reader
      .prepare(
        "SELECT run_id,attempt_id FROM events WHERE type='judge.started' AND run_id=?",
      )
      .all(parent.run.id);
    expect(judged).toEqual([{ run_id: parent.run.id, attempt_id: attemptId }]);
    const expectedRows = reader
      .prepare(
        "SELECT * FROM events WHERE attempt_id=? AND run_id IN (?,?) ORDER BY sequence",
      )
      .all(attemptId, child.run.id, parent.run.id);
    const expected: ObservationEvent[] = expectedRows.map((row) => ({
      sequence: Number(row.sequence),
      createdAt: String(row.created_at),
      type: String(row.type),
      message: String(row.message),
      runId: String(row.run_id),
      attemptId: String(row.attempt_id),
      ...(row.data ? { data: JSON.parse(String(row.data)) } : {}),
    }));
    const beforeReads = state();
    const collected: ObservationEvent[] = [];
    let cursor = 0;
    for (;;) {
      const input = { runId: parent.run.id, attemptId, cursor };
      const response = await post("runs.attempt-events", input);
      expect(response.status).toBe(200);
      const page = (await response.json()) as {
        events: ObservationEvent[];
        cursor: number;
      };
      expect(page.events.length).toBeLessThanOrEqual(200);
      expect(
        await runCli([
          "runs.attempt-events",
          "--url",
          server.url,
          "--json",
          JSON.stringify(input),
        ]),
      ).toEqual(page);
      collected.push(...page.events);
      cursor = page.cursor;
      if (!page.events.length) break;
    }
    expect(collected.length).toBeGreaterThan(200);
    expect(collected).toEqual(expected);
    expect(new Set(collected.map((event) => event.sequence)).size).toBe(
      collected.length,
    );
    expect(
      collected.some(
        (event) =>
          event.type === "judge.started" && event.runId === parent.run.id,
      ),
    ).toBe(true);
    expect(
      collected.some((event) => event.message.includes("SIBLING_CONTEXT")),
    ).toBe(false);
    const childPage = await (
      await post("runs.attempt-events", { runId: child.run.id, attemptId })
    ).json();
    expect(childPage.events).toEqual(
      expected.filter((event) => event.runId === child.run.id),
    );
    expect(
      (await post("runs.attempt-events", { runId: sibling.run.id, attemptId }))
        .status,
    ).toBe(404);
    await expect(
      runCli([
        "runs.attempt-events",
        "--url",
        server.url,
        "--json",
        JSON.stringify({ runId: sibling.run.id, attemptId }),
      ]),
    ).rejects.toMatchObject({ response: { error: { code: "not_found" } } });
    const detail = await (
      await post("runs.attempt", { runId: parent.run.id, attemptId })
    ).json();
    expect(detail).not.toHaveProperty("events");
    expect(detail.attempt.evidenceHash).toBe(digest(detail.attempt.output));
    expect(physicalBytes()).toBe(beforePhysical);
    expect(state()).toBe(beforeReads);
    expect(targets).toBe(3);
    expect(judges).toBe(1);
  } finally {
    reader?.close();
    if (server) await server.close();
    else await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
