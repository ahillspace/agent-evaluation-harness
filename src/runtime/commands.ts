import { existsSync, statSync, accessSync, constants } from "node:fs";
import path from "node:path";
const INHERITED = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "CODEX_HOME",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
];

export function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    INHERITED.flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]!]],
    ),
  );
}

function executableFile(filename: string): boolean {
  try {
    if (!statSync(filename).isFile()) return false;
    accessSync(filename, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
export function resolveExecutable(
  name: string,
  environment: Record<string, string> = inheritedEnvironment(),
): string {
  if (path.isAbsolute(name) && executableFile(name)) return name;
  const directories = (environment.PATH ?? "").split(path.delimiter);
  for (const directory of directories) {
    for (const extension of process.platform === "win32"
      ? /\.(exe|com)$/i.test(name)
        ? [""]
        : [".exe", ".com"]
      : [""]) {
      const candidate = path.join(directory, `${name}${extension}`);
      if (executableFile(candidate)) return candidate;
    }
  }
  // Resolve npm's JavaScript launcher without invoking cmd.exe or interpreting arguments.
  if (process.platform === "win32" && name === "opencode") {
    for (const directory of directories) {
      const binary = path.join(
        directory,
        "node_modules/opencode-ai/node_modules/opencode-windows-x64/bin/opencode.exe",
      );
      if (executableFile(binary)) return binary;
    }
  }
  throw new Error(`Executable is unavailable: ${name}.`);
}

export function resolveCommand(
  name: string,
  args: string[],
  environment = inheritedEnvironment(),
): { executable: string; args: string[] } {
  if (process.platform === "win32" && (name === "npx" || name === "npm")) {
    const script = path.join(
      path.dirname(process.execPath),
      `node_modules/npm/bin/${name === "npx" ? "npx" : "npm"}-cli.js`,
    );
    if (!existsSync(script))
      throw new Error(
        "The npm CLI is unavailable. Configure an explicit MCP executable.",
      );
    return { executable: process.execPath, args: [script, ...args] };
  }
  return { executable: resolveExecutable(name, environment), args };
}
