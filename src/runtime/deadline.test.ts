import { expect, it } from "vitest";
import { ConnectionGate } from "./connection-gate.js";
import { withInvocationDeadline } from "./deadline.js";

it("times out a queued credential reservation before it starts provider work", async () => {
  const gate = new ConnectionGate();
  const unlock = await gate.acquire(["pat"]);
  let started = false;
  await expect(
    withInvocationDeadline(25, new AbortController().signal, async (signal) => {
      const release = await gate.acquire(["pat"], signal);
      started = true;
      release();
    }),
  ).rejects.toMatchObject({ code: "timeout" });
  expect(started).toBe(false);
  unlock();
  (await gate.acquire(["pat"]))();
});

it("never masks a failed cleanup with a control interruption", async () => {
  const controller = new AbortController();
  await expect(
    withInvocationDeadline(1000, controller.signal, async () => {
      controller.abort();
      throw Object.assign(new Error("Cleanup failed"), {
        code: "cleanup_failed",
      });
    }),
  ).rejects.toMatchObject({ code: "cleanup_failed" });
});
