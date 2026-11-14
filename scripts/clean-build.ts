import { lstat, realpath, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const output = join(root, "dist");
const stats = await lstat(output).catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return undefined;
  throw error;
});

if (stats) {
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    relative(root, await realpath(output)) !== "dist"
  ) {
    throw new Error("Refusing to clean redirected build output");
  }
  await rm(output, { recursive: true, force: true });
}
