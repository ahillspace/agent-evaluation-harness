// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./app.js";

vi.mock("./banks.js", () => ({ Banks: () => <p>Bank library</p> }));
vi.mock("./settings.js", () => ({ Settings: () => <p>Settings workspace</p> }));
vi.mock("./runs.js", () => ({ Runs: () => <p>Run library</p> }));
vi.mock("./observe.js", () => ({
  Observe: (props: Record<string, unknown>) => (
    <output aria-label="Run detail">{JSON.stringify(props)}</output>
  ),
}));
vi.mock("./setup.js", () => ({
  Setup: (props: Record<string, unknown>) => {
    const [edits, setEdits] = useState(0);
    return (
      <>
        <output aria-label="Run setup">{JSON.stringify(props)}</output>
        <button onClick={() => setEdits(edits + 1)}>
          Draft edits: {edits}
        </button>
        <button onClick={props.refresh as () => void}>Refresh workspace</button>
      </>
    );
  },
}));

let root: Root, container: HTMLDivElement;
const request = vi.fn();
const workspace = {
  workspaceId: "workspace",
  banks: [],
  runs: [],
  blueprints: [],
  connections: [],
  researchSessions: [],
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  request.mockReset().mockResolvedValue(Response.json(workspace));
  vi.stubGlobal("fetch", request);
  window.history.replaceState(null, "", "/");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function open(path: string, initial = false) {
  await act(async () => {
    window.history.replaceState(null, "", path ? `#${path}` : "/");
    if (initial) root.render(<App />);
    else window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}
function props(label: string) {
  return JSON.parse(
    container.querySelector(`[aria-label="${label}"]`)!.textContent!,
  );
}
it.each(["", "/runs", "/results"])(
  "opens the run library at %s without launching work",
  async (path) => {
    await open(path, true);
    expect(container.textContent).toContain("Run library");
    expect(
      container.querySelector('nav [aria-current="page"]')?.textContent,
    ).toBe("Runs");
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "/api/commands/workspace.get",
    ]);
  },
);
it.each(["/run", "/runs/new"])(
  "preserves setup reuse inputs at %s",
  async (path) => {
    await open(`${path}?source=run%20one&blueprint=plan%2Fone`, true);
    expect(props("Run setup")).toMatchObject({
      sourceRunId: "run one",
      blueprintId: "plan/one",
    });
    expect(
      container.querySelector('header a[href="#/runs"]')?.textContent,
    ).toBe("Runs");
    expect(container.querySelector("header")?.textContent).toContain("New run");
    expect(request).toHaveBeenCalledTimes(1);
  },
);
it.each(["/observe/run-one", "/runs/run-one"])(
  "opens recorded selections at %s without launching work",
  async (path) => {
    await open(
      `${path}?session=session%2Fone&result=result%20one&score=score%2Fone`,
      true,
    );
    expect(props("Run detail")).toMatchObject({
      runId: "run-one",
      sessionId: "session/one",
      initialResultId: "result one",
      initialAssessmentId: "score/one",
    });
    expect(
      container.querySelector('header a[href="#/runs"]')?.textContent,
    ).toBe("Runs");
    expect(container.querySelector("header")?.textContent).toContain(
      "Run details",
    );
    expect(request).toHaveBeenCalledTimes(1);
  },
);
it("retains setup identity across legacy and canonical aliases, including reordered queries", async () => {
  await open("/run?source=one&blueprint=two", true);
  await act(async () => container.querySelector("button")!.click());
  await open("/runs/new?blueprint=two&source=one");
  expect(container.textContent).toContain("Draft edits: 1");
  await open("/run?source=one&blueprint=two");
  expect(container.textContent).toContain("Draft edits: 1");
  await open("/runs/new?source=another");
  expect(container.textContent).toContain("Draft edits: 0");
  expect(request).toHaveBeenCalledTimes(1);
});
it("keeps the current workspace and setup edits mounted while a refresh is pending or fails", async () => {
  await open("/runs/new", true);
  await act(async () => container.querySelector("button")!.click());
  const setup = container.querySelector('[aria-label="Run setup"]');
  let finish!: (response: Response) => void;
  request.mockReturnValueOnce(
    new Promise<Response>((resolve) => {
      finish = resolve;
    }),
  );
  const refresh = () =>
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Refresh workspace")!
      .click();
  await act(async () => refresh());
  expect(container.querySelector('[aria-label="Run setup"]')).toBe(setup);
  expect(container.textContent).toContain("Draft edits: 1");
  expect(container.textContent).not.toContain("Opening your workspace...");
  await act(async () =>
    finish(
      Response.json(
        { error: { message: "Workspace refresh failed." } },
        { status: 500 },
      ),
    ),
  );
  expect(container.textContent).toContain("Workspace refresh failed.");
  expect(container.querySelector('[aria-label="Run setup"]')).toBe(setup);
  expect(container.textContent).toContain("Draft edits: 1");
  request.mockResolvedValueOnce(Response.json(workspace));
  await act(async () => refresh());
  expect(container.querySelector('[aria-label="Run setup"]')).toBe(setup);
  expect(container.textContent).toContain("Draft edits: 1");
  expect(container.textContent).not.toContain("Workspace refresh failed.");
});
it("follows navigation and history events without submitting a launch", async () => {
  await open("/runs/new", true);
  await open("/runs");
  expect(container.textContent).toContain("Run library");
  await open("/runs/saved?score=historical");
  expect(props("Run detail").initialAssessmentId).toBe("historical");
  await open("/runs/new");
  expect(container.querySelector('[aria-label="Run setup"]')).not.toBeNull();
  expect(
    request.mock.calls.every(([url]) => url === "/api/commands/workspace.get"),
  ).toBe(true);
});
