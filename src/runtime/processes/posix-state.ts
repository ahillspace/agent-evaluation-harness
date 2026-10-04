import { execFile } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);
const leaseSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("posix"),
    id: z.string().uuid(),
    state: z.enum(["prepared", "running", "cleaned"]),
    watchdogPid: z.number().int().min(2).optional(),
    watchdogStarted: z.string().optional(),
    runnerPid: z.number().int().min(2).optional(),
    runnerStarted: z.string().optional(),
  })
  .strict();
export type PosixLease = z.infer<typeof leaseSchema>;
export async function readLease(filename: string): Promise<PosixLease> {
  return leaseSchema.parse(JSON.parse(await readFile(filename, "utf8")));
}
export async function writeLease(filename: string, lease: PosixLease) {
  const temporary = `${filename}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(leaseSchema.parse(lease)), {
    mode: 0o600,
  });
  await rename(temporary, filename);
}
export function groupExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 2)
    throw new Error("Invalid process group identity.");
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
export function signalGroup(pid: number, signal: NodeJS.Signals) {
  if (!Number.isInteger(pid) || pid < 2)
    throw new Error("Invalid process group identity.");
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
export const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
export async function drainGroup(pid: number, owns: () => Promise<boolean>) {
  if (!groupExists(pid)) return;
  if (!(await owns())) throw new Error("Cannot verify the owned group leader.");
  signalGroup(pid, "SIGTERM");
  for (let index = 0; index < 10 && groupExists(pid); index++) await delay(50);
  if (groupExists(pid)) {
    if (!(await owns()))
      throw new Error("Group identity changed during cleanup.");
    signalGroup(pid, "SIGKILL");
  }
  for (let index = 0; index < 100 && groupExists(pid); index++) await delay(50);
  if (groupExists(pid)) throw new Error("Owned process group did not settle.");
}
export async function processIdentity(
  pid: number,
): Promise<{ started: string; command: string; uid: number } | undefined> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
    throw error;
  }
  let stdout: string;
  try {
    ({ stdout } = await execute(
      "/bin/ps",
      [
        "-ww",
        "-p",
        String(pid),
        "-o",
        "uid=",
        "-o",
        "lstart=",
        "-o",
        "command=",
      ],
      {
        timeout: 2000,
        maxBuffer: 65536,
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
      },
    ));
  } catch {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
    }
    throw new Error("Cannot verify process identity.");
  }
  const match =
    /^\s*(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/s.exec(
      stdout.trim(),
    );
  if (!match) throw new Error("Cannot parse process identity.");
  return {
    uid: Number(match[1]),
    started: match[2]!.replace(/\s+/g, " "),
    command: match[3]!.trim(),
  };
}

export async function verifyOwner(
  pid: number,
  started: string | undefined,
  id: string,
  entry: string,
): Promise<boolean> {
  const identity = await processIdentity(pid);
  if (!identity) return false;
  if (
    !started ||
    identity.started !== started ||
    identity.uid !== process.getuid?.() ||
    !identity.command.includes(entry) ||
    !new RegExp(`(?:^|\\s)${id}(?:\\s|$)`).test(identity.command)
  )
    throw new Error(
      "Process identity changed; recovery requires inspection before new work.",
    );
  return true;
}
