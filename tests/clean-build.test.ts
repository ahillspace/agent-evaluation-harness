import { execFile } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const actual = await realpath(directory);
    expect(dirname(actual)).toBe(await realpath(tmpdir()));
    expect(relative(await realpath(tmpdir()), actual)).toMatch(
      /^aeh-clean-build-/,
    );
    await rm(actual, { recursive: true, force: true });
  }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "aeh-clean-build-"));
  directories.push(directory);
  const repo = join(directory, "checkout with spaces");
  await mkdir(join(repo, "scripts"), { recursive: true });
  const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  try {
    await copyFile(
      resolve("scripts/clean-build.ts"),
      join(repo, "scripts/clean-build.ts"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await symlink(
    resolve("node_modules"),
    join(repo, "node_modules"),
    "junction",
  );
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: {
        prebuild: manifest.scripts.prebuild,
        build: "node -e \"console.log('fixture compiler reached')\"",
      },
    }),
  );
  const build = async () => {
    try {
      const result = await execute(
        process.execPath,
        [
          process.env.npm_execpath ??
            join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
          "--prefix",
          repo,
          "run",
          "build",
        ],
        { cwd: directory, windowsHide: true, timeout: 15_000 },
      );
      return { code: 0, output: result.stdout + result.stderr };
    } catch (error) {
      const result = error as { code: number; stdout: string; stderr: string };
      return { code: result.code, output: result.stdout + result.stderr };
    }
  };
  return { directory, repo, build };
}

it("removes stale compiler output before build and preserves non-output files", async () => {
  const f = await fixture();
  const source = join(f.repo, "src", "retired.ts");
  await mkdir(dirname(source));
  await writeFile(source, "export const retired = true;\n");
  await execute(
    process.execPath,
    [
      createRequire(import.meta.url).resolve("typescript/bin/tsc"),
      source,
      "--outDir",
      join(f.repo, "dist"),
      "--declaration",
      "--sourceMap",
      "--skipLibCheck",
      "--types",
      "node",
    ],
    { cwd: f.repo, windowsHide: true, timeout: 15_000 },
  );
  await rm(source);
  const preserved = [
    join(f.repo, "src", "live.ts"),
    join(f.repo, ".aeh", "saved-evidence"),
    join(f.directory, "outside-output"),
  ];
  for (const file of preserved) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "preserved\n");
  }
  expect(await lstat(join(f.repo, "dist", "retired.js"))).toBeDefined();
  const built = await f.build();
  expect(built.code, built.output).toBe(0);
  expect(built.output).toContain("fixture compiler reached");
  await expect(lstat(join(f.repo, "dist"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  for (const file of preserved) {
    expect(await readFile(file, "utf8")).toBe("preserved\n");
  }
});

it("builds repeatedly when output is absent", async () => {
  const f = await fixture();
  for (let count = 0; count < 2; count++) {
    const built = await f.build();
    expect(built.code, built.output).toBe(0);
    expect(built.output).toContain("fixture compiler reached");
  }
});

it("anchors cleanup to the script's checkout when invoked from another directory", async () => {
  const f = await fixture();
  const unrelated = join(f.directory, "dist");
  await mkdir(unrelated);
  await writeFile(join(unrelated, "sentinel"), "preserved\n");
  await mkdir(join(f.repo, "dist"));
  await execute(
    process.execPath,
    [
      "--import",
      pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
      join(f.repo, "scripts/clean-build.ts"),
    ],
    { cwd: f.directory, windowsHide: true, timeout: 15_000 },
  );
  await expect(lstat(join(f.repo, "dist"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(join(unrelated, "sentinel"), "utf8")).toBe(
    "preserved\n",
  );
});

it("refuses a redirected output directory before compilation", async () => {
  const f = await fixture();
  const outside = join(f.directory, "outside-output");
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "preserved\n");
  await symlink(outside, join(f.repo, "dist"), "junction");
  const built = await f.build();
  expect(built.code, built.output).not.toBe(0);
  expect(built.output).toContain("Refusing to clean redirected build output");
  expect(built.output).not.toContain("fixture compiler reached");
  expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("preserved\n");
  expect((await lstat(join(f.repo, "dist"))).isSymbolicLink()).toBe(true);
});
