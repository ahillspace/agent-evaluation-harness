import { execFile } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);
const knownProcessStates = new Set(["D", "I", "R", "S", "T", "U", "W"]);
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
export type GroupMember = {
  pid: number;
  pgid: number;
  uid: number;
  state: string;
};
export type GroupStatus = "empty" | "zombies" | "live";
export type GroupSnapshot = { status: GroupStatus; members: GroupMember[] };
/** The persisted launch identity anchors a zombie-only group after its leader exits. */
export type GroupOwnership = {
  verify: () => Promise<boolean>;
  zombieAnchor?: { pid: number; started: string; scopeId: string };
};
export type GroupOperations = {
  probe: (pid: number) => void;
  listMembers: (pid: number) => Promise<GroupMember[]>;
  signal: (pid: number, signal: NodeJS.Signals) => void;
  pause: (milliseconds: number) => Promise<void>;
  uid: number;
};

export function parseGroupMembers(output: string): GroupMember[] {
  const members: GroupMember[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match)
      throw new Error("Cannot parse process group membership inspection.");
    const pid = Number(match[1]);
    const pgid = Number(match[2]);
    const uid = Number(match[3]);
    const state = match[4]!;
    if (
      !Number.isSafeInteger(pid) ||
      pid < 0 ||
      !Number.isSafeInteger(pgid) ||
      pgid < 0 ||
      !Number.isSafeInteger(uid) ||
      uid < 0
    )
      throw new Error(
        "Cannot classify process group member state or identity.",
      );
    members.push({ pid, pgid, uid, state });
  }
  return members;
}

async function listProcessGroupMembers(): Promise<GroupMember[]> {
  const { stdout } = await execute(
    "/bin/ps",
    ["-axo", "pid=", "-o", "pgid=", "-o", "uid=", "-o", "stat="],
    {
      timeout: 2000,
      maxBuffer: 4 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
    },
  );
  return parseGroupMembers(stdout);
}

function groupOperations(
  overrides: Partial<GroupOperations> = {},
): GroupOperations {
  return {
    probe: (pid) => process.kill(-pid, 0),
    listMembers: listProcessGroupMembers,
    signal: signalGroup,
    pause: delay,
    uid: process.geteuid?.() ?? process.getuid?.() ?? -1,
    ...overrides,
  };
}

export async function inspectGroup(
  pid: number,
  overrides: Partial<GroupOperations> = {},
): Promise<GroupSnapshot> {
  if (!Number.isInteger(pid) || pid < 2)
    throw new Error("Invalid process group identity.");
  const operations = groupOperations(overrides);
  let permissionDenied = false;
  try {
    operations.probe(pid);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { status: "empty", members: [] };
    if (code !== "EPERM") throw error;
    permissionDenied = true;
  }
  const members = (await operations.listMembers(pid)).filter(
    (member) => member.pgid === pid,
  );
  if (members.length === 0) {
    if (permissionDenied)
      throw new Error(
        "Cannot verify permission-denied process group membership.",
      );
    try {
      operations.probe(pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH")
        return { status: "empty", members: [] };
      throw error;
    }
    throw new Error(
      "Process group exists but membership inspection found no members.",
    );
  }
  if (
    members.some(
      (member) =>
        !Number.isSafeInteger(member.pid) ||
        member.pid < 2 ||
        !Number.isSafeInteger(member.uid) ||
        member.uid < 0 ||
        !/^[A-Z][+<>NslL]*$/.test(member.state) ||
        !(
          member.state[0] === "Z" ||
          knownProcessStates.has(member.state[0] ?? "")
        ),
    )
  )
    throw new Error("Cannot classify process group member state or identity.");
  if (members.some((member) => member.uid !== operations.uid))
    throw new Error("Process group contains an unowned process member.");
  members.sort((left, right) => left.pid - right.pid);
  return {
    status: members.every((member) => member.state.startsWith("Z"))
      ? "zombies"
      : "live",
    members,
  };
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
export async function drainGroup(
  pid: number,
  ownership: GroupOwnership,
  overrides: Partial<GroupOperations> = {},
) {
  const operations = groupOperations(overrides);
  const deadline = Date.now() + 7500;
  const inspect = () => inspectGroup(pid, operations);
  const stableSettled = async (first: GroupSnapshot) => {
    if (first.status === "live" || Date.now() >= deadline) return false;
    await operations.pause(50);
    if (Date.now() >= deadline) return false;
    const next = await inspect();
    return (
      next.status === first.status &&
      JSON.stringify(next.members) === JSON.stringify(first.members)
    );
  };
  const stableOwnedZombies = async (first: GroupSnapshot) => {
    if (first.status !== "zombies" || !(await stableSettled(first)))
      return false;
    let verified = false;
    try {
      verified = await ownership.verify();
    } catch {
      /* A stable zombie group can use its persisted launch identity. */
    }
    const anchor = ownership.zombieAnchor;
    if (
      verified ||
      (anchor?.pid === pid &&
        /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(
          anchor.started,
        ) &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
          anchor.scopeId,
        ))
    )
      return true;
    throw new Error("Cannot verify the owned zombie process group identity.");
  };
  const settles = async (first: GroupSnapshot) => {
    if (first.status === "empty") return stableSettled(first);
    if (first.status === "zombies") return stableOwnedZombies(first);
    return false;
  };
  let snapshot = await inspect();
  if (Date.now() >= deadline)
    throw new Error("Owned process group cleanup exceeded its deadline.");
  if (await settles(snapshot)) return;
  if (!(await ownership.verify()))
    throw new Error("Cannot verify the owned group leader.");
  if (Date.now() >= deadline)
    throw new Error("Owned process group cleanup exceeded its deadline.");
  try {
    operations.signal(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  }
  for (let index = 0; index < 10 && Date.now() < deadline; index++) {
    snapshot = await inspect();
    if (await settles(snapshot)) return;
    await operations.pause(50);
  }
  if (Date.now() >= deadline)
    throw new Error("Owned process group cleanup exceeded its deadline.");
  if (!(await ownership.verify()))
    throw new Error("Group identity changed during cleanup.");
  if (Date.now() >= deadline)
    throw new Error("Owned process group cleanup exceeded its deadline.");
  try {
    operations.signal(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  }
  for (let index = 0; index < 100 && Date.now() < deadline; index++) {
    snapshot = await inspect();
    if (await settles(snapshot)) return;
    await operations.pause(50);
  }
  throw new Error("Owned process group did not settle.");
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
