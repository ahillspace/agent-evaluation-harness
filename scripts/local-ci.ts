import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

function git(...args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function install(): void {
  const root = git("rev-parse", "--show-toplevel");
  process.chdir(root);
  const current = spawnSync(
    "git",
    ["config", "--path", "--get", "core.hooksPath"],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (current.error) throw current.error;
  if (current.status !== 0 && current.status !== 1) {
    throw new Error(current.stderr.trim() || "Cannot read core.hooksPath.");
  }
  const hooksPath = current.stdout.trim();
  if (
    current.status === 0 &&
    resolve(root, hooksPath) !== resolve(root, ".githooks")
  ) {
    throw new Error(
      `core.hooksPath already points to ${JSON.stringify(hooksPath)}. Integrate the existing hooks before installing local CI. No configuration changed.`,
    );
  }
  if (current.status === 1) {
    const defaultHooks = git("rev-parse", "--git-path", "hooks");
    let existing: string[] = [];
    try {
      existing = readdirSync(defaultHooks, { withFileTypes: true })
        .filter(
          (entry) =>
            !entry.name.endsWith(".sample") &&
            (entry.isFile() || entry.isSymbolicLink()),
        )
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing.length > 0) {
      throw new Error(
        `Existing default Git hooks: ${existing.join(", ")}. Integrate the existing hooks before installing local CI. No configuration changed.`,
      );
    }
  }
  git("config", "--local", "core.hooksPath", ".githooks");
  console.log("Installed local CI pre-push hook for this checkout.");
}

function requireClean(): void {
  if (
    git(
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignore-submodules=none",
    )
  ) {
    throw new Error(
      "Local CI requires a clean checkout, including staged, untracked, and submodule changes. Commit or stash changes, then retry the push.",
    );
  }
}

function prePush(): number {
  // Consume Git's ref input before any child process starts.
  const input = readFileSync(0, "utf8").trim();
  const updates = input
    ? input.split(/\r?\n/).map((line) => line.split(/\s+/))
    : [];
  for (const update of updates) {
    if (
      update.length !== 4 ||
      !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(update[1] ?? "")
    ) {
      throw new Error("Invalid pre-push ref input from Git.");
    }
  }
  const commits = updates.filter((update) => !/^0+$/.test(update[1]!));
  if (commits.length === 0) return 0;

  const head = git("rev-parse", "--verify", "HEAD");
  for (const [ref, sha] of commits) {
    let commit: string | undefined;
    try {
      commit = git("rev-parse", "--verify", `${sha}^{commit}`);
    } catch {
      // Tags pointing to non-commit objects cannot be validated as a checkout.
    }
    if (commit !== head) {
      throw new Error(
        `${ref} does not resolve to the checked-out HEAD (${head}). Push only HEAD and tags at HEAD; check out and push unrelated commits separately.`,
      );
    }
  }
  requireClean();
  console.log(`Local CI: validating ${head} with npm run validate.`);
  const validation = spawnSync(
    process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npm",
    process.platform === "win32"
      ? ["/d", "/s", "/c", "npm.cmd run validate"]
      : ["run", "validate"],
    {
      // Windows requires a shell for npm.cmd; the command and arguments are fixed.
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    },
  );
  if (validation.error) throw validation.error;
  if (validation.status !== 0) {
    console.error(
      `Local CI validation failed (${validation.signal ?? validation.status ?? "unknown status"}). Push blocked.`,
    );
    return validation.status ?? 1;
  }
  if (git("rev-parse", "--verify", "HEAD") !== head) {
    throw new Error(
      "HEAD changed during local CI. Keep the checkout idle and retry the push.",
    );
  }
  requireClean();
  console.log(`Validated ${head}. Local pre-push checks passed.`);
  return 0;
}

try {
  const command = process.argv[2];
  if (command === "install") install();
  else if (command === "pre-push") process.exitCode = prePush();
  else throw new Error("Usage: tsx scripts/local-ci.ts install|pre-push");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
