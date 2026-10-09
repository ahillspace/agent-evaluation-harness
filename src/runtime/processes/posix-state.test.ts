import { expect, it, vi } from "vitest";
import {
  drainGroup,
  inspectGroup,
  parseGroupMembers,
  type GroupMember,
  type GroupOwnership,
} from "./posix-state.js";

const owner = vi.fn(async () => true);
const ownership: GroupOwnership = { verify: owner };
const pause = vi.fn(async () => undefined);

function groupOps(probe: () => void, members: GroupMember[], signal = vi.fn()) {
  const listMembers = vi.fn(async () => members);
  return {
    probe,
    listMembers,
    signal,
    pause,
    uid: 501,
  };
}

it("parses Darwin process group rows and rejects incomplete inventory rows", () => {
  expect(parseGroupMembers("  42  41  501 Z+\n  41  41  501 S")).toEqual([
    { pid: 42, pgid: 41, uid: 501, state: "Z+" },
    { pid: 41, pgid: 41, uid: 501, state: "S" },
  ]);
  expect(() => parseGroupMembers("invalid row")).toThrow(/parse/i);
});

it("ignores PID 1 and unrelated unknown states while inspecting the owned group", async () => {
  const inventory = [
    "1 1 0 Ss",
    "0 0 0 ?",
    "90 88 1002 ?",
    "42 41 501 Z+",
    "41 41 501 S",
  ].join("\n");

  await expect(
    inspectGroup(41, {
      probe: vi.fn(),
      listMembers: async () => parseGroupMembers(inventory),
      uid: 501,
    }),
  ).resolves.toMatchObject({ status: "live" });
});

it("settles zombie descendants after the runner has been reaped", async () => {
  const probe = () => {
    throw Object.assign(new Error("Permission denied"), { code: "EPERM" });
  };
  const ops = groupOps(probe, [{ pid: 42, pgid: 41, uid: 501, state: "Z+" }]);

  const ownership: GroupOwnership = {
    verify: async () => false,
    zombieAnchor: {
      pid: 41,
      started: "Wed Oct 7 23:53:22 2026",
      scopeId: "8b2903e2-568d-4165-8fe7-1350842a0daf",
    },
  };

  await expect(drainGroup(41, ownership, ops)).resolves.toBeUndefined();
  expect(ops.signal).not.toHaveBeenCalled();
  expect(ops.listMembers).toHaveBeenCalledTimes(2);
});

it("settles a zombie runner when its single-process probe returns EPERM", async () => {
  const probe = () => {
    throw Object.assign(new Error("Permission denied"), { code: "EPERM" });
  };
  const ops = groupOps(probe, [
    { pid: 41, pgid: 41, uid: 501, state: "Z+" },
    { pid: 42, pgid: 41, uid: 501, state: "Z" },
  ]);
  const ownership: GroupOwnership = {
    verify: async () => {
      throw Object.assign(new Error("Permission denied"), { code: "EPERM" });
    },
    zombieAnchor: {
      pid: 41,
      started: "Wed Oct 7 23:53:22 2026",
      scopeId: "8b2903e2-568d-4165-8fe7-1350842a0daf",
    },
  };

  await expect(drainGroup(41, ownership, ops)).resolves.toBeUndefined();
  expect(ops.signal).not.toHaveBeenCalled();
});

it("does not accept zombies without a trusted persisted group anchor", async () => {
  const probe = () => {
    throw Object.assign(new Error("Permission denied"), { code: "EPERM" });
  };
  const ops = groupOps(probe, [{ pid: 42, pgid: 41, uid: 501, state: "Z+" }]);

  await expect(
    drainGroup(41, { verify: async () => false }, ops),
  ).rejects.toThrow(/ownership|identity/i);
  expect(ops.signal).not.toHaveBeenCalled();
});

it("keeps zombie cleanup unresolved when a group member has an unowned UID", async () => {
  const probe = () => {
    throw Object.assign(new Error("Permission denied"), { code: "EPERM" });
  };
  const ops = groupOps(probe, [{ pid: 42, pgid: 41, uid: 1001, state: "Z" }]);
  const zombieOwnership: GroupOwnership = {
    verify: async () => false,
    zombieAnchor: {
      pid: 41,
      started: "Wed Oct 7 23:53:22 2026",
      scopeId: "8b2903e2-568d-4165-8fe7-1350842a0daf",
    },
  };

  await expect(drainGroup(41, zombieOwnership, ops)).rejects.toThrow(
    /unowned/i,
  );
  expect(ops.signal).not.toHaveBeenCalled();
});

it("keeps cleanup unresolved when permission denial hides a live unowned member", async () => {
  const probe = () => {
    throw Object.assign(new Error("Permission denied"), { code: "EPERM" });
  };
  const ops = groupOps(probe, [{ pid: 42, pgid: 41, uid: 1001, state: "S" }]);

  await expect(drainGroup(41, ownership, ops)).rejects.toThrow(
    /unowned|live|permission/i,
  );
  expect(ops.signal).not.toHaveBeenCalled();
});

it("keeps cleanup unresolved when a permitted group member remains live", async () => {
  const ops = groupOps(vi.fn(), [{ pid: 42, pgid: 41, uid: 501, state: "S" }]);

  await expect(drainGroup(41, ownership, ops)).rejects.toThrow(
    /did not settle/i,
  );
  expect(ops.signal).toHaveBeenCalledWith(41, "SIGTERM");
  expect(ops.signal).toHaveBeenCalledWith(41, "SIGKILL");
});

it("keeps cleanup unresolved when a successful group probe has no listed members", async () => {
  const ops = groupOps(vi.fn(), []);

  await expect(drainGroup(41, ownership, ops)).rejects.toThrow(/no members/i);
  expect(ops.signal).not.toHaveBeenCalled();
});

it("accepts ESRCH as an empty group", async () => {
  const probe = () => {
    throw Object.assign(new Error("No such process"), { code: "ESRCH" });
  };

  await expect(
    drainGroup(41, ownership, groupOps(probe, [])),
  ).resolves.toBeUndefined();
});

it("keeps cleanup unresolved when process state cannot be classified", async () => {
  const ops = groupOps(vi.fn(), [{ pid: 42, pgid: 41, uid: 501, state: "?" }]);

  await expect(drainGroup(41, ownership, ops)).rejects.toThrow(
    /state|inspect/i,
  );
  expect(ops.signal).not.toHaveBeenCalled();
});

it("does not settle when a zombie-only snapshot changes before stability is confirmed", async () => {
  let observations = 0;
  const listMembers = vi.fn(async () =>
    observations++ === 0
      ? [{ pid: 42, pgid: 41, uid: 501, state: "Z" }]
      : observations === 2
        ? [{ pid: 43, pgid: 41, uid: 501, state: "Z" }]
        : [{ pid: 43, pgid: 41, uid: 501, state: "S" }],
  );
  const ops = {
    ...groupOps(vi.fn(), []),
    listMembers,
  };

  await expect(drainGroup(41, ownership, ops)).rejects.toThrow(
    /did not settle/i,
  );
});

it("keeps live group cleanup fail-closed when the leader identity is unavailable", async () => {
  const verify = vi.fn(async () => false);
  const ops = groupOps(vi.fn(), [{ pid: 42, pgid: 41, uid: 501, state: "S" }]);

  await expect(drainGroup(41, { verify }, ops)).rejects.toThrow(
    /verify the owned group leader/i,
  );
  expect(verify).toHaveBeenCalledOnce();
  expect(ops.signal).not.toHaveBeenCalled();
});
