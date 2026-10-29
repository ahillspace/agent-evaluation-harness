import { execFile } from "node:child_process";
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(validation = "") {
  const directory = await mkdtemp(join(tmpdir(), "aeh-local-ci-"));
  directories.push(directory);
  const repo = join(directory, "checkout with spaces");
  const remote = join(directory, "remote.git");
  await mkdir(join(repo, ".githooks"), { recursive: true });
  await mkdir(join(repo, "scripts"));
  await copyFile(
    resolve(".githooks/pre-push"),
    join(repo, ".githooks/pre-push"),
  );
  await chmod(join(repo, ".githooks/pre-push"), 0o755);
  await copyFile(
    resolve("scripts/local-ci.ts"),
    join(repo, "scripts/local-ci.ts"),
  );
  await symlink(
    resolve("node_modules"),
    join(repo, "node_modules"),
    "junction",
  );
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: { validate: "node validate.cjs" },
    }),
  );
  await writeFile(
    join(repo, ".gitignore"),
    "node_modules/\nvalidation-marker\n",
  );
  await writeFile(join(repo, "tracked.txt"), "original\n");
  await writeFile(
    join(repo, "validate.cjs"),
    `const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
if (fs.readFileSync(0, 'utf8') !== '') process.exit(91);
fs.appendFileSync('validation-marker', 'run\\n');
console.log('fixture validation output');
${validation}\n`,
  );
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  env.GIT_CONFIG_GLOBAL = join(directory, "global-config");
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  await writeFile(env.GIT_CONFIG_GLOBAL, "");
  async function run(command: string, args: string[]) {
    try {
      const result = await execute(command, args, {
        cwd: repo,
        env,
        timeout: 30_000,
        windowsHide: true,
      });
      return { code: 0, output: result.stdout + result.stderr };
    } catch (error) {
      const result = error as { code: number; stdout: string; stderr: string };
      return { code: result.code, output: result.stdout + result.stderr };
    }
  }
  async function git(...args: string[]) {
    const result = await run("git", args);
    expect(result.code, result.output).toBe(0);
    return result.output.trim();
  }
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "Local CI fixture");
  await git("config", "user.email", "local-ci@example.invalid");
  await git("config", "commit.gpgsign", "false");
  await git("config", "tag.gpgsign", "false");
  await git("add", ".");
  await git("commit", "-m", "Fixture");
  await git("init", "--bare", "--initial-branch=main", remote);
  await git("remote", "add", "origin", remote);
  const install = () =>
    run(process.execPath, [
      "--import",
      "tsx",
      "scripts/local-ci.ts",
      "install",
    ]);
  const installed = await install();
  expect(installed.code, installed.output).toBe(0);
  return {
    repo,
    remote,
    run,
    git,
    install,
    env,
    marker: () => readFile(join(repo, "validation-marker"), "utf8"),
  };
}

it("validates a real push once for a branch and annotated tag at HEAD", async () => {
  const f = await fixture();
  const head = await f.git("rev-parse", "HEAD");
  await f.git("tag", "-a", "release", "-m", "Release");
  const pushed = await f.run("git", ["push", "origin", "main", "release"]);
  expect(pushed.code, pushed.output).toBe(0);
  expect(pushed.output).toContain("fixture validation output");
  expect(pushed.output).toContain(`Validated ${head}`);
  expect(await f.marker()).toBe("run\n");
  expect(await f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(head);
}, 40_000);

it("blocks a failed validation and preserves its exit status", async () => {
  const f = await fixture("process.exit(23);");
  const pushed = await f.run("git", ["push", "origin", "main"]);
  expect(pushed.code).not.toBe(0);
  expect(pushed.output).toContain("23");
  expect(await f.marker()).toBe("run\n");
  expect(await f.git("ls-remote", "origin")).toBe("");
}, 40_000);

it.each(["tracked", "staged", "untracked"])(
  "blocks %s changes before starting validation",
  async (kind) => {
    const f = await fixture();
    await appendFile(
      join(f.repo, kind === "untracked" ? "new.txt" : "tracked.txt"),
      "dirty\n",
    );
    if (kind === "staged") await f.git("add", "tracked.txt");
    const pushed = await f.run("git", ["push", "origin", "main"]);
    expect(pushed.code).not.toBe(0);
    expect(pushed.output).toContain("clean");
    await expect(f.marker()).rejects.toThrow();
    expect(await f.git("ls-remote", "origin")).toBe("");
  },
  40_000,
);

it.each(["branch", "annotated tag", "blob tag"])(
  "rejects a pushed %s that does not resolve to HEAD",
  async (kind) => {
    const f = await fixture();
    if (kind === "branch") await f.git("branch", "other");
    else if (kind === "annotated tag")
      await f.git("tag", "-a", "other", "-m", "Old");
    else
      await f.git("tag", "other", await f.git("rev-parse", "HEAD:tracked.txt"));
    await f.git("commit", "--allow-empty", "-m", "Next");
    const pushed = await f.run("git", ["push", "origin", "main", "other"]);
    expect(pushed.code).not.toBe(0);
    expect(pushed.output).toContain("HEAD");
    await expect(f.marker()).rejects.toThrow();
    expect(await f.git("ls-remote", "origin")).toBe("");
  },
  40_000,
);

it.each([
  ["worktree", "fs.appendFileSync('tracked.txt', 'changed');"],
  [
    "HEAD",
    "execFileSync('git', ['commit', '--allow-empty', '-m', 'Concurrent change']);",
  ],
])(
  "rejects a %s change during validation",
  async (_kind, validation) => {
    const f = await fixture(validation);
    const pushed = await f.run("git", ["push", "origin", "main"]);
    expect(pushed.code).not.toBe(0);
    expect(pushed.output).not.toContain("Validated ");
    expect(await f.marker()).toBe("run\n");
    expect(await f.git("ls-remote", "origin")).toBe("");
  },
  40_000,
);

it("permits deletion-only pushes without validation, even in a dirty checkout", async () => {
  const f = await fixture();
  await f.git("push", "--no-verify", "origin", "main:obsolete");
  await appendFile(join(f.repo, "tracked.txt"), "dirty\n");
  const pushed = await f.run("git", ["push", "origin", ":obsolete"]);
  expect(pushed.code, pushed.output).toBe(0);
  await expect(f.marker()).rejects.toThrow();
  expect(await f.git("ls-remote", "origin")).toBe("");
}, 40_000);

it("detects dirty submodules even when Git is configured to ignore them", async () => {
  const f = await fixture();
  await f.git("push", "--no-verify", "origin", "main");
  await f.git(
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    f.remote,
    "child",
  );
  await f.git("commit", "-am", "Add child");
  await f.git("config", "submodule.child.ignore", "all");
  await appendFile(join(f.repo, "child", "tracked.txt"), "dirty\n");
  const pushed = await f.run("git", ["push", "origin", "main"]);
  expect(pushed.code).not.toBe(0);
  expect(pushed.output).toContain("clean");
  await expect(f.marker()).rejects.toThrow();
}, 40_000);

it.each(["local", "inherited"])(
  "preserves a conflicting %s hooks path",
  async (scope) => {
    const f = await fixture();
    await f.git("config", "--local", "--unset", "core.hooksPath");
    if (scope === "local")
      await f.git("config", "core.hooksPath", "other-hooks");
    else
      await writeFile(
        f.env.GIT_CONFIG_GLOBAL!,
        "[core]\n\thooksPath = other-hooks\n",
      );
    const installed = await f.install();
    expect(installed.code).not.toBe(0);
    expect(installed.output).toContain("other-hooks");
    expect(await f.git("config", "--get", "core.hooksPath")).toBe(
      "other-hooks",
    );
  },
  40_000,
);

it.each(["pre-push", "pre-commit"])(
  "preserves a default custom %s hook when hooksPath is unset",
  async (hook) => {
    const f = await fixture();
    await f.git("config", "--local", "--unset", "core.hooksPath");
    const hooksDirectory = resolve(
      f.repo,
      await f.git("rev-parse", "--git-path", "hooks"),
    );
    const hookPath = join(hooksDirectory, hook);
    const contents = "#!/bin/sh\necho custom hook\n";
    await writeFile(hookPath, contents);
    await chmod(hookPath, 0o755);
    const installed = await f.install();
    expect(installed.code).not.toBe(0);
    expect(installed.output).toContain(hook);
    expect(installed.output).toContain("Integrate");
    const config = await f.run("git", ["config", "--get", "core.hooksPath"]);
    expect(config.code).toBe(1);
    expect(config.output).toBe("");
    expect(await readFile(hookPath, "utf8")).toBe(contents);
  },
  40_000,
);

it("installs idempotently without changing tracked files", async () => {
  const f = await fixture();
  const installed = await f.install();
  expect(installed.code, installed.output).toBe(0);
  expect(await f.git("config", "--local", "--get", "core.hooksPath")).toBe(
    ".githooks",
  );
  expect(await f.git("status", "--porcelain")).toBe("");
}, 40_000);
