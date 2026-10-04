import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  chmod,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveCommand,
  resolveExecutable,
  inheritedEnvironment,
} from "./commands.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
it("preserves explicit executable paths and literal Unicode arguments", () => {
  const args = ["space in argument", "caf\u00e9", "$(not-a-shell-command)"];
  expect(resolveCommand(process.execPath, args)).toEqual({
    executable: process.execPath,
    args,
  });
});
it("does not inherit unrelated host credentials", () => {
  expect(inheritedEnvironment()).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  expect(inheritedEnvironment()).not.toHaveProperty("OPENAI_API_KEY");
});
it.skipIf(process.platform === "win32")(
  "resolves executable symlinks and rejects directories and files without execute permission",
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "aeh commands \u00e9-"),
    );
    directories.push(directory);
    const file = path.join(directory, "provider");
    await writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    expect(() => resolveExecutable("provider", { PATH: directory })).toThrow(
      "unavailable",
    );
    await chmod(file, 0o700);
    expect(resolveExecutable("provider", { PATH: directory })).toBe(file);
    await symlink(file, path.join(directory, "alias"));
    expect(resolveExecutable("alias", { PATH: directory })).toBe(
      path.join(directory, "alias"),
    );
    await mkdir(path.join(directory, "folder"));
    expect(() => resolveExecutable("folder", { PATH: directory })).toThrow(
      "unavailable",
    );
  },
);
