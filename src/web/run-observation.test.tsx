// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RunView } from "../contracts.js";
import { useRunObservation } from "./run-observation.js";

let root: Root, container: HTMLDivElement;
let current: ReturnType<typeof useRunObservation>;
function Probe({ runId }: { runId: string }) {
  current = useRunObservation(runId);
  return <span>{current.data?.run.id}</span>;
}
const snapshot = (id: string, status = "running") =>
  ({
    run: { id, status, manifest: { digest: `frozen-${id}` } },
    results: [],
    attempts: [],
    jevAssessments: [],
    reviews: [],
    allowedActions: [],
    progress: { completed: 0, failed: 0, total: 1 },
  }) as unknown as RunView;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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
it("refreshes snapshots without event cursors and retains the manifest across manual refresh", async () => {
  const first = snapshot("one");
  const request = vi.fn(async (url: string, _options: RequestInit) =>
    Response.json(
      url.endsWith("/runs.get")
        ? first
        : {
            ...snapshot("one", "paused"),
            run: { id: "one", status: "paused" },
          },
    ),
  );
  vi.stubGlobal("fetch", request);
  await act(async () => root.render(<Probe runId="one" />));
  expect(current.data?.run.id).toBe("one");
  const manifest = current.data!.run.manifest;
  expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toEqual({
    runId: "one",
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1499);
  });
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(request.mock.calls.map(([url]) => url)).toEqual([
    "/api/commands/runs.get",
    "/api/commands/runs.observe",
  ]);
  expect(current.data?.run.manifest).toBe(manifest);
  expect(current.data?.run.status).toBe("paused");
  await act(async () => current.refresh());
  expect(request.mock.calls.map(([url]) => url)).toEqual([
    "/api/commands/runs.get",
    "/api/commands/runs.observe",
    "/api/commands/runs.observe",
  ]);
  expect(current.data?.run.manifest).toBe(manifest);
  for (const [, options] of request.mock.calls)
    expect(JSON.parse(options!.body as string)).toEqual({ runId: "one" });
});
it("isolates switched Runs and ignores late responses after cancellation", async () => {
  let release!: (response: Response) => void;
  const waiting = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const request = vi.fn(async (_url: string, options: RequestInit) =>
    JSON.parse(options.body as string).runId === "one"
      ? waiting
      : Response.json(snapshot("two")),
  );
  vi.stubGlobal("fetch", request);
  await act(async () => root.render(<Probe runId="one" />));
  expect(current.data).toBeNull();
  await act(async () => root.render(<Probe runId="two" />));
  expect((request.mock.calls[0]![1]!.signal as AbortSignal).aborted).toBe(true);
  const manifest = current.data!.run.manifest;
  await act(async () => release(Response.json(snapshot("one"))));
  expect(current.data?.run.id).toBe("two");
  expect(current.data?.run.manifest).toBe(manifest);
  expect(container.textContent).toBe("two");
  expect(request.mock.calls.map(([url]) => url)).toEqual([
    "/api/commands/runs.get",
    "/api/commands/runs.get",
  ]);
  await act(async () => root.unmount());
  expect((request.mock.calls[1]![1]!.signal as AbortSignal).aborted).toBe(true);
});
it("does not apply an old compact response after switching to another frozen Run", async () => {
  let release!: (response: Response) => void;
  const waiting = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const request = vi.fn(async (url: string, options: RequestInit) =>
    url.endsWith("/runs.observe")
      ? waiting
      : Response.json(snapshot(JSON.parse(options.body as string).runId)),
  );
  vi.stubGlobal("fetch", request);
  await act(async () => root.render(<Probe runId="one" />));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  await act(async () => root.render(<Probe runId="two" />));
  const manifest = current.data!.run.manifest;
  expect(manifest.digest).toBe("frozen-two");
  expect((request.mock.calls[1]![1]!.signal as AbortSignal).aborted).toBe(true);
  await act(async () =>
    release(Response.json({ run: { id: "one", status: "cancelled" } })),
  );
  expect(current.data?.run.id).toBe("two");
  expect(current.data?.run.manifest).toBe(manifest);
  expect(request.mock.calls.map(([url]) => url)).toEqual([
    "/api/commands/runs.get",
    "/api/commands/runs.observe",
    "/api/commands/runs.get",
  ]);
});
it("bootstraps again when switching back before another Run finishes loading", async () => {
  let release!: (response: Response) => void;
  const waiting = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const request = vi.fn(async (_url: string, options: RequestInit) =>
    JSON.parse(options.body as string).runId === "two"
      ? waiting
      : Response.json(snapshot("one")),
  );
  vi.stubGlobal("fetch", request);
  await act(async () => root.render(<Probe runId="one" />));
  await act(async () => root.render(<Probe runId="two" />));
  await act(async () => root.render(<Probe runId="one" />));
  expect(request.mock.calls.map(([url]) => url)).toEqual([
    "/api/commands/runs.get",
    "/api/commands/runs.get",
    "/api/commands/runs.get",
  ]);
  await act(async () => release(Response.json(snapshot("two"))));
  expect(current.data?.run.id).toBe("one");
});
