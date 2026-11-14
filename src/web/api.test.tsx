// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useResource } from "./api.js";

function Draft() {
  const [edits, setEdits] = useState(0);
  return (
    <button onClick={() => setEdits(edits + 1)}>Draft edits: {edits}</button>
  );
}
function Resource({
  connectionId = "old",
  enabled = true,
  interval,
}: {
  connectionId?: string;
  enabled?: boolean;
  interval?: number;
}) {
  const resource = useResource(
    "connections.test",
    { connectionId },
    interval,
    enabled,
  );
  return (
    <>
      <output aria-label="Data">{JSON.stringify(resource.data)}</output>
      <output aria-label="Error">{resource.error?.message}</output>
      <output aria-label="Loading">{String(resource.loading)}</output>
      <button onClick={resource.refresh}>Refresh</button>
      {resource.data && <Draft />}
    </>
  );
}
function deferred() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

let root: Root, container: HTMLDivElement;
const request = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  request.mockReset();
  vi.stubGlobal("fetch", request);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const render = async (props: Parameters<typeof Resource>[0] = {}) =>
  act(async () => root.render(<Resource {...props} />));
const data = () => container.querySelector('[aria-label="Data"]')!.textContent;
const error = () =>
  container.querySelector('[aria-label="Error"]')!.textContent;
const loading = () =>
  container.querySelector('[aria-label="Loading"]')!.textContent;
const refresh = async () =>
  act(async () => {
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Refresh")!
      .click();
  });

it("ignores late responses from an aborted activation even when the request identity matches again", async () => {
  const original = deferred(),
    replacement = deferred();
  request
    .mockReturnValueOnce(original.promise)
    .mockReturnValueOnce(replacement.promise);
  await render();
  expect(loading()).toBe("true");
  const signal = (request.mock.calls[0]![1] as RequestInit).signal!;
  await render({ enabled: false });
  expect(loading()).toBe("false");
  expect(signal.aborted).toBe(true);
  await render();
  await act(async () =>
    original.resolve(Response.json({ label: "aborted connection" })),
  );
  expect(loading()).toBe("true");
  expect(data()).toBe("null");
  await act(async () =>
    replacement.resolve(Response.json({ label: "current connection" })),
  );
  expect(data()).toContain("current connection");
  expect(loading()).toBe("false");
  expect(data()).not.toContain("aborted connection");
});

it("retains current data and mounted draft state during an ordinary refresh, failure, and recovery", async () => {
  const failed = deferred(),
    recovered = deferred();
  request
    .mockResolvedValueOnce(Response.json({ label: "current connection" }))
    .mockReturnValueOnce(failed.promise)
    .mockReturnValueOnce(recovered.promise);
  await render();
  const draft = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Draft edits: 0",
  )!;
  await act(async () => draft.click());
  await refresh();
  expect(loading()).toBe("true");
  expect(data()).toContain("current connection");
  expect(draft.isConnected).toBe(true);
  await act(async () => failed.reject(new Error("Refresh failed.")));
  expect(data()).toContain("current connection");
  expect(error()).toBe("Refresh failed.");
  expect(loading()).toBe("false");
  expect(draft.textContent).toBe("Draft edits: 1");
  await refresh();
  expect(loading()).toBe("true");
  expect(data()).toContain("current connection");
  await act(async () =>
    recovered.resolve(Response.json({ label: "refreshed connection" })),
  );
  expect(data()).toContain("refreshed connection");
  expect(error()).toBe("");
  expect(loading()).toBe("false");
  expect(draft.isConnected).toBe(true);
  expect(draft.textContent).toBe("Draft edits: 1");
});

it("retains data during a scheduled poll and clears an error after a successful later poll", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  request
    .mockResolvedValueOnce(Response.json({ label: "current connection" }))
    .mockRejectedValueOnce(new Error("Poll failed."))
    .mockResolvedValueOnce(Response.json({ label: "polled connection" }));
  await render({ interval: 1000 });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(data()).toContain("current connection");
  expect(error()).toBe("Poll failed.");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(data()).toContain("polled connection");
  expect(error()).toBe("");
});

it("isolates old request errors across input changes and disablement", async () => {
  const other = deferred();
  request
    .mockRejectedValueOnce(new Error("Old connection failed."))
    .mockReturnValueOnce(other.promise);
  await render();
  expect(error()).toBe("Old connection failed.");
  await render({ connectionId: "other" });
  expect(error()).toBe("");
  expect(loading()).toBe("true");
  await act(async () => other.reject(new Error("Other connection failed.")));
  expect(error()).toBe("Other connection failed.");
  expect(loading()).toBe("false");
  await render({ connectionId: "other", enabled: false });
  expect(error()).toBe("");
  expect(loading()).toBe("false");
});

it("keeps a replacement request loading when a cancelled request fails late", async () => {
  const old = deferred(),
    current = deferred();
  request.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  await render();
  const signal = (request.mock.calls[0]![1] as RequestInit).signal!;
  await render({ connectionId: "current" });
  expect(signal.aborted).toBe(true);
  await act(async () => old.reject(new Error("Late old failure")));
  expect(error()).toBe("");
  expect(loading()).toBe("true");
  await act(async () => current.resolve(Response.json({ label: "current" })));
  expect(loading()).toBe("false");
  expect(data()).toContain("current");
});
