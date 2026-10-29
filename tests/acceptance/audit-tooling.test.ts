import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import type { Application } from "../../src/application/application.js";
import { runCli } from "../../src/cli.js";
import { startServer } from "../../src/server.js";
import { Database } from "../../src/storage/database.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it.each(["127.0.0.1", "localhost", "::1"])(
  "exposes a usable discovery and CLI URL on %s",
  async (host) => {
    const execute = vi.fn(async () => ({ marker: "same-engine" }));
    const application = {
      execute,
      close: async () => {},
      waitForIdle: async () => {},
    } as Application;
    const server = await startServer({ application, host, port: 0 });
    cleanups.push(() => server.close());
    const url = new URL(server.url);
    expect(url.hostname).toBe(host === "::1" ? "[::1]" : host);
    const discovery = await fetch(`${server.url}/api/discovery`);
    expect(discovery.ok).toBe(true);
    expect(await runCli(["discover", "--url", server.url])).toEqual(
      await discovery.json(),
    );
    expect(await runCli(["workspace.get", "--url", server.url])).toEqual({
      marker: "same-engine",
    });
    expect(execute).toHaveBeenCalledWith("workspace.get", {});
  },
);

it("seeds an isolated preview with recorded LLM verdicts using the shared evidence contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeh-seed-audit-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const dataDirectory = join(directory, "requested-preview");
  const output = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
      resolve("scripts/seed-observation-preview.ts"),
      "--data-directory",
      dataDirectory,
    ],
    { cwd: directory, windowsHide: true, timeout: 60_000 },
  );
  expect(JSON.parse(output.stdout)).toMatchObject({ directory: dataDirectory });
  const db = new Database(join(dataDirectory, "workspace.sqlite"));
  try {
    const passes = db
      .list("assessmentPass")
      .filter((pass) => pass.source === "llm");
    expect(passes.length).toBeGreaterThan(0);
    const judgments = passes
      .flatMap((pass) => pass.judgments)
      .filter((judgment) => judgment.attemptId);
    expect(judgments.length).toBeGreaterThan(0);
    expect(
      judgments.every((judgment) =>
        ["correct", "incorrect"].includes(judgment.status),
      ),
    ).toBe(true);
    expect(judgments.some((judgment) => judgment.status === "incorrect")).toBe(
      true,
    );
  } finally {
    db.close();
  }
}, 70_000);
