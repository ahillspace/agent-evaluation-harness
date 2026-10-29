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

it.each(["inventory", "identity"])(
  "does not report settled after a slow %s exceeds the cleanup deadline",
  async (phase) => {
    let now = 0;
    let inventories = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const ops = {
        ...groupOps(vi.fn(), []),
        listMembers: async () => {
          if (++inventories === 2 && phase === "inventory") now = 8000;
          return [{ pid: 41, pgid: 41, uid: 501, state: "Z" }];
        },
      };
      await expect(
        drainGroup(
          41,
          {
            verify: async () => {
              if (phase === "identity") now = 8000;
              return true;
            },
          },
          ops,
        ),
      ).rejects.toThrow(/deadline/i);
      expect(ops.signal).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  },
);

it.each(["start time", "scope identity", "UID", "command"])(
  "never overrides a conflicting %s in a zombie group",
  async (field) => {
    const ops = groupOps(vi.fn(), [
      { pid: 41, pgid: 41, uid: 501, state: "Z" },
    ]);
    await expect(
      drainGroup(
        41,
        {
          verify: async () => {
            throw new Error(`Process identity changed: ${field}`);
          },
        },
        ops,
      ),
    ).rejects.toThrow(/identity changed/i);
    expect(ops.signal).not.toHaveBeenCalled();
  },
);

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

it("reinspects a transient Darwin EPERM inventory gap until ESRCH proves settlement", async () => {
  const probe = vi
    .fn()
    .mockImplementationOnce(() => {
      throw Object.assign(new Error(), { code: "EPERM" });
    })
    .mockImplementation(() => {
      throw Object.assign(new Error(), { code: "ESRCH" });
    });
  const ops = groupOps(probe, []);
  await expect(inspectGroup(41, ops)).resolves.toEqual({
    status: "empty",
    members: [],
  });
  expect(probe).toHaveBeenCalledTimes(2);
});

it("bounds repeated EPERM inventory gaps without declaring settlement", async () => {
  const probe = vi.fn(() => {
    throw Object.assign(new Error(), { code: "EPERM" });
  });
  await expect(inspectGroup(41, groupOps(probe, []))).rejects.toThrow(
    /permission-denied/i,
  );
  expect(probe).toHaveBeenCalledTimes(21);
});

it("retains verified live-group continuity while its leader is reaped during cleanup", async () => {
  let signalled = false;
  const ops = {
    ...groupOps(vi.fn(), []),
    listMembers: async () =>
      signalled
        ? [{ pid: 42, pgid: 41, uid: 501, state: "Z" }]
        : [
            { pid: 41, pgid: 41, uid: 501, state: "S" },
            { pid: 42, pgid: 41, uid: 501, state: "S" },
          ],
    signal: vi.fn(() => {
      signalled = true;
    }),
  };
  await expect(
    drainGroup(41, { verify: async () => !signalled }, ops),
  ).resolves.toBeUndefined();
  expect(ops.signal).toHaveBeenCalledTimes(1);
});

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

it("does not trust a reaped leader from an earlier cleanup or persisted lease", async () => {
  const probe = () => {
    throw Object.assign(new Error("Permission denied"), { code: "EPERM" });
  };
  const ops = groupOps(probe, [{ pid: 42, pgid: 41, uid: 501, state: "Z+" }]);

  const ownership: GroupOwnership = {
    verify: async () => false,
  };

  await expect(drainGroup(41, ownership, ops)).rejects.toThrow(/identity/i);
  expect(ops.signal).not.toHaveBeenCalled();
  expect(ops.listMembers).toHaveBeenCalledTimes(2);
});

it("does not override a permission-denied ownership inspection", async () => {
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
  };

  await expect(drainGroup(41, ownership, ops)).rejects.toThrow(
    /Permission denied/i,
  );
  expect(ops.signal).not.toHaveBeenCalled();
});

it("does not accept zombies without verified current ownership", async () => {
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
