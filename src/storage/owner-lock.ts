import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppError } from "../domain/errors.js";

/** The OS releases SQLite's file lock on process death; no stale owner can unlink a new lock. */
export async function acquireOwnerLock(
  directory: string,
): Promise<() => Promise<void>> {
  // This file is an ownership primitive, not another application catalog.
  const lock = new DatabaseSync(join(directory, "engine-owner.lock"));
  try {
    lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
  } catch (error) {
    lock.close();
    if (
      error instanceof Error &&
      /database (?:is )?(?:locked|busy)/i.test(error.message)
    ) {
      throw new AppError(
        "workspace_locked",
        "Another engine owns this workspace. Connect to its HTTP endpoint.",
      );
    }
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      lock.exec("ROLLBACK;");
    } finally {
      lock.close();
    }
  };
}
