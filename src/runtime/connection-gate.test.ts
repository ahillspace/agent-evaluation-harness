import { expect, it, vi } from "vitest";
import { ConnectionGate, tableauSessionKey } from "./connection-gate.js";

it("serializes the same PAT across connection aliases but permits independent credentials", async () => {
  const gate = new ConnectionGate();
  const firstKey = tableauSessionKey("https://example.com/", "credential");
  const sameKey = tableauSessionKey("https://EXAMPLE.com", "credential");
  expect(firstKey).toBe(sameKey);
  const release = await gate.acquire([firstKey]);
  let admitted = false;
  const next = gate.acquire([sameKey]).then((unlock) => {
    admitted = true;
    return unlock;
  });
  const independent = await gate.acquire([
    tableauSessionKey("https://example.com", "different"),
  ]);
  expect(admitted).toBe(false);
  independent();
  release();
  const unlock = await next;
  expect(admitted).toBe(true);
  unlock();
});

it("cancels a waiting invocation without acquiring the credential", async () => {
  const gate = new ConnectionGate();
  const release = await gate.acquire(["shared"]);
  const controller = new AbortController();
  const waiting = gate.acquire(["shared"], controller.signal);
  controller.abort(new Error("Stopped"));
  await expect(waiting).rejects.toThrow("Stopped");
  release();
  (await gate.acquire(["shared"]))();
});

it("notifies once only when blocked, without passing credential keys", async () => {
  const gate = new ConnectionGate();
  const onWait = vi.fn();
  const release = await gate.acquire(["private-key"], undefined, onWait);
  expect(onWait).not.toHaveBeenCalled();
  const independent = await gate.acquire(["other-key"], undefined, onWait);
  expect(onWait).not.toHaveBeenCalled();
  const pending = gate.acquire(["private-key"], undefined, onWait);
  expect(onWait.mock.calls).toEqual([[]]);
  independent();
  await Promise.resolve();
  expect(onWait.mock.calls).toEqual([[]]);
  release();
  (await pending)();
  expect(onWait.mock.calls).toEqual([[]]);
});

it("notifies a cancelled waiter once and does not notify an already cancelled request", async () => {
  const gate = new ConnectionGate();
  const release = await gate.acquire(["shared"]);
  const onWait = vi.fn();
  const controller = new AbortController();
  const pending = gate.acquire(["shared"], controller.signal, onWait);
  controller.abort(new Error("Stopped"));
  await expect(pending).rejects.toThrow("Stopped");
  await expect(
    gate.acquire(["shared"], controller.signal, onWait),
  ).rejects.toThrow("Stopped");
  expect(onWait.mock.calls).toEqual([[]]);
  release();
  (await gate.acquire(["shared"], undefined, onWait))();
  expect(onWait.mock.calls).toEqual([[]]);
});
