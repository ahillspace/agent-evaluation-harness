import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { inheritedEnvironment } from "./commands.js";
import type { McpBinding } from "./connections.js";
import { prepareTableauFeatureGate } from "./tableau-feature-gate.js";

const resourceDirectory = (stateDirectory: string) =>
  path.resolve(stateDirectory, "mcp-resources");

/** Called only by the workspace owner after all persisted process scopes settle. */
export async function recoverMcpResources(
  stateDirectory: string,
): Promise<void> {
  const root = resourceDirectory(stateDirectory);
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^invocation-[A-Za-z0-9]{6}$/.test(entry.name))
      throw new Error("Unrecognized MCP recovery resource.");
    await rm(path.join(root, entry.name), { recursive: true, force: true });
  }
}

/** The surviving runtime owns modules; contained bridges only receive finalized bindings. */
export async function prepareMcpBindings(
  bindings: McpBinding[],
  stateDirectory: string,
): Promise<{ mcp: McpBinding[]; cleanup: () => Promise<void> }> {
  let directory: string | undefined;
  const cleanup = async () => {
    if (directory)
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  };
  try {
    const mcp: McpBinding[] = [];
    for (const binding of bindings) {
      if (Object.keys(binding.features ?? {}).length && !directory) {
        const root = resourceDirectory(stateDirectory);
        await mkdir(root, { recursive: true, mode: 0o700 });
        directory = await mkdtemp(path.join(root, "invocation-"));
      }
      const prepared = await prepareTableauFeatureGate(
        binding.features ?? {},
        { ...inheritedEnvironment(), ...binding.env },
        directory,
      );
      const { features: _features, ...resolved } = binding;
      mcp.push({ ...resolved, env: prepared.env });
    }
    return { mcp, cleanup };
  } catch (error) {
    // No provider has received these bindings yet, so deletion is safe.
    await cleanup();
    throw error;
  }
}
