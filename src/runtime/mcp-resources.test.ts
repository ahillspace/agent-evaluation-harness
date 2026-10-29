import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { prepareMcpBindings, recoverMcpResources } from "./mcp-resources.js";
import { helperCommand } from "./harness.js";
import { createProcessSupervisor } from "./platform.js";

it("freezes the shared minimal environment into bridge bindings without inheriting provider secrets", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aeh-mcp-resources-"));
  vi.stubEnv(
    "NODE_EXTRA_CA_CERTS",
    path.join(directory, "company certificates.pem"),
  );
  vi.stubEnv("OPENAI_API_KEY", "unrelated-provider-credential");
  vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
  try {
    const prepared = await prepareMcpBindings(
      [
        {
          name: "tableau",
          command: process.execPath,
          args: [],
          env: { Future_option: "literal" },
          tools: [],
        },
      ],
      directory,
    );
    expect(prepared.mcp[0]!.env).toMatchObject({
      NODE_EXTRA_CA_CERTS: path.join(directory, "company certificates.pem"),
      Future_option: "literal",
    });
    expect(prepared.mcp[0]!.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(prepared.mcp[0]!.env).not.toHaveProperty(
      "NODE_TLS_REJECT_UNAUTHORIZED",
    );
    await prepared.cleanup();
    await expect(
      access(path.join(directory, "mcp-resources")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

it.skipIf(!["win32", "darwin"].includes(process.platform))(
  "keeps bridge modules under parent ownership across cancellation and recovers abandoned resources after scope settlement",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "aeh-mcp-recovery-"));
    const supervisor = createProcessSupervisor({ stateDirectory: directory });
    try {
      await supervisor.recover();
      const entry = path.join(directory, "server.cjs");
      await writeFile(
        path.join(directory, "features.json"),
        JSON.stringify({ defaultEnabled: true }),
      );
      await writeFile(
        entry,
        `const Provider = require(JSON.parse(process.env.FEATURE_GATE_PROVIDER_CONFIG).module).default; const provider = new Provider(); provider.isFeatureEnabled('defaultEnabled').then(enabled => console.log(JSON.stringify({ enabled, module: JSON.parse(process.env.FEATURE_GATE_PROVIDER_CONFIG).module }))); setInterval(() => {}, 1000);`,
      );
      const prepared = await prepareMcpBindings(
        [
          {
            name: "tableau",
            command: process.execPath,
            args: [entry],
            env: {},
            tools: [],
            features: { futureFeature: true },
          },
        ],
        directory,
      );
      const modulePath = JSON.parse(
        prepared.mcp[0]!.env.FEATURE_GATE_PROVIDER_CONFIG!,
      ).module;
      expect(path.relative(directory, modulePath)).toMatch(
        /^mcp-resources[\\/]invocation-/,
      );
      expect(prepared.mcp[0]).not.toHaveProperty("features");
      const command = helperCommand("connection", "AEH_TEST_MCP_BINDING");
      const stop = new AbortController();
      const result = await supervisor.run({
        executable: command.command,
        args: command.args,
        cwd: directory,
        env: { AEH_TEST_MCP_BINDING: JSON.stringify(prepared.mcp[0]) },
        timeoutMs: 15_000,
        processLimit: 4,
        keepStdinOpen: true,
        signal: stop.signal,
        onLine(line) {
          expect(JSON.parse(line)).toEqual({
            enabled: true,
            module: modulePath,
          });
          stop.abort();
        },
      });
      expect(result.interrupted).toBe(true);
      // Contained bridge exit never owns removal of its parent's resource.
      await access(modulePath);
      await supervisor.close();
      const recovery = createProcessSupervisor({ stateDirectory: directory });
      try {
        await recovery.recover();
        await recoverMcpResources(directory);
      } finally {
        await recovery.close();
      }
      await expect(access(modulePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readdir(path.join(directory, "mcp-resources"))).toEqual([]);
      await prepared.cleanup();
    } finally {
      await supervisor.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
