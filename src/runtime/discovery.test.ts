import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverHarness } from "./discovery.js";
import type { ProcessSupervisor } from "./process-supervisor.js";

it("discovers Claude local authentication without fabricating a model catalog", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aeh-discovery-"));
  const calls: string[][] = [];
  const supervisor = {
    run: async ({ args }: { args: string[] }) => {
      calls.push(args);
      return {
        exitCode: 0,
        stdout:
          args[0] === "--version"
            ? "2.1.248 (Claude Code)"
            : JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
      };
    },
  } as unknown as ProcessSupervisor;
  try {
    expect(
      await discoverHarness(supervisor, "claude", directory),
    ).toMatchObject({
      id: "claude",
      available: true,
      authenticated: true,
      models: [],
    });
    expect(calls).toEqual([["--version"], ["auth", "status"]]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("rejects Claude versions without restricted mode", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aeh-discovery-"));
  const supervisor = {
    run: async () => ({ exitCode: 0, stdout: "2.1.247 (Claude Code)" }),
  } as unknown as ProcessSupervisor;
  try {
    expect(
      await discoverHarness(supervisor, "claude", directory),
    ).toMatchObject({
      available: false,
      error: expect.stringContaining("2.1.248"),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
