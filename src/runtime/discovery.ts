import { mkdir } from "node:fs/promises";
import type { HarnessInfo } from "../contracts.js";
import { ProcessSupervisor } from "./process-supervisor.js";
import { record } from "./harness.js";

export async function discoverHarness(
  supervisor: ProcessSupervisor,
  harness: "codex" | "opencode",
  cwd: string,
): Promise<HarnessInfo> {
  await mkdir(cwd, { recursive: true });
  const info: HarnessInfo = { id: harness, available: false, models: [] };
  try {
    const version = await supervisor.run({
      executable: harness,
      args: ["--version"],
      cwd,
      processLimit: 3,
      timeoutMs: 15_000,
    });
    if (version.exitCode !== 0)
      throw new Error("The installed harness did not respond.");
    info.available = true;
    info.version = version.stdout.trim().slice(0, 100);
    if (harness === "opencode") {
      const [models, auth] = await Promise.all([
        supervisor.run({
          executable: harness,
          args: ["--pure", "models"],
          cwd,
          processLimit: 5,
          timeoutMs: 45_000,
        }),
        supervisor.run({
          executable: harness,
          args: ["--pure", "auth", "list"],
          cwd,
          processLimit: 3,
          timeoutMs: 20_000,
        }),
      ]);
      if (models.exitCode !== 0 || models.timedOut)
        throw new Error("OpenCode model discovery failed.");
      info.models = [
        ...new Set(
          models.stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => /^[a-z0-9][a-z0-9._-]*\/\S+$/i.test(line)),
        ),
      ].map((id) => ({ id, name: id, provider: id.split("/")[0] }));
      info.authenticated = /[1-9]\d* credential/i.test(
        auth.stdout + auth.stderr,
      );
      return info;
    }
    const stop = new AbortController();
    let accountReceived = false,
      modelsReceived = false,
      rpcError = false;
    const seenCursors = new Set<string>();
    let modelRequest = 3;
    await supervisor.run({
      executable: harness,
      args: ["app-server", "--listen", "stdio://"],
      cwd,
      processLimit: 4,
      timeoutMs: 30_000,
      signal: stop.signal,
      keepStdinOpen: true,
      input: `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "agent_evaluation_harness", title: "Agent Evaluation Harness", version: "0.1.0" }, capabilities: null } })}\n`,
      onLine(line, write) {
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          return;
        }
        if (!record(raw)) return;
        if (raw.error) {
          rpcError = true;
          stop.abort();
          return;
        }
        if (raw.id === 1) {
          write(`${JSON.stringify({ method: "initialized" })}\n`);
          write(
            `${JSON.stringify({ id: 2, method: "account/read", params: { refreshToken: false } })}\n`,
          );
          write(
            `${JSON.stringify({ id: modelRequest, method: "model/list", params: { limit: 100, includeHidden: false } })}\n`,
          );
        }
        if (raw.id === 2 && record(raw.result)) {
          info.authenticated = Boolean(raw.result.account);
          accountReceived = true;
        }
        if (raw.id === modelRequest && record(raw.result)) {
          const data = Array.isArray(raw.result.data) ? raw.result.data : [];
          for (const item of data)
            if (record(item) && typeof item.model === "string")
              info.models.push({
                id: item.model,
                name:
                  typeof item.displayName === "string"
                    ? item.displayName
                    : item.model,
                provider: "openai",
              });
          const cursor = raw.result.nextCursor;
          if (typeof cursor === "string" && cursor) {
            if (seenCursors.has(cursor) || seenCursors.size > 20) {
              rpcError = true;
              stop.abort();
              return;
            }
            seenCursors.add(cursor);
            write(
              `${JSON.stringify({ id: ++modelRequest, method: "model/list", params: { limit: 100, includeHidden: false, cursor } })}\n`,
            );
          } else modelsReceived = true;
        }
        if (accountReceived && modelsReceived) stop.abort();
      },
    });
    if (rpcError || !accountReceived || !modelsReceived)
      throw new Error("Codex account or model discovery did not complete.");
    return info;
  } catch (error) {
    info.error =
      error instanceof Error ? error.message : "Harness discovery failed.";
    return info;
  }
}
