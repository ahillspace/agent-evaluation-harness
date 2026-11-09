// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RunView } from "../contracts.js";
import { RetryFailures } from "./retry-failures.js";
import { RunRecoveryNotice, useRunRecovery } from "./run-recovery.js";

const { command } = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("./api.js", () => ({ command }));
let root: Root;
let container: HTMLDivElement;
const onAcknowledged = vi.fn();
const view = (available = true) =>
  ({
    run: { id: "run", execution: { id: "execution-one" } },
    retryEligibility: {
      available,
      resultIds: ["failed"],
      requiresAcknowledgment: false,
      reason: "Stop active work first.",
    },
  }) as unknown as RunView;
function Harness({
  current = view(),
  workspaceId = "workspace",
}: {
  current?: RunView;
  workspaceId?: string;
}) {
  const recovery = useRunRecovery({
    workspaceId,
    runId: current.run.id,
    onAcknowledged,
  });
  return (
    <>
      <button
        onClick={() =>
          void recovery.submit({
            operation: "runs.control",
            input: {
              runId: current.run.id,
              action: "resume",
              idempotencyKey: "resume-key",
              expectedExecutionId: "execution-one",
              acknowledgeDuplicateWork: true,
            },
          })
        }
      >
        Resume
      </button>
      <RunRecoveryNotice recovery={recovery} />
      <RetryFailures view={current} recovery={recovery} />
    </>
  );
}
function button(label: string) {
  const found = Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.clear();
  command.mockReset();
  onAcknowledged.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("uses engine eligibility and excludes answered slots", async () => {
  await act(async () => root.render(<Harness current={view(false)} />));
  expect(button("Rerun failed questions (1)").disabled).toBe(true);
  expect(button("Rerun failed questions (1)").title).toBe(
    "Stop active work first.",
  );
  const answered = view();
  answered.retryEligibility!.resultIds = [];
  await act(async () => root.render(<Harness current={answered} />));
  expect(container.textContent).not.toContain("Rerun failed");
});
it("recovers this Run and acknowledges its saved score without navigation or applying answers", async () => {
  command.mockResolvedValue({ run: { id: "run" } });
  await act(async () => root.render(<Harness />));
  await act(async () => button("Rerun failed questions (1)").click());
  expect(document.body.textContent).toContain(
    "Earlier attempts and scores stay available.",
  );
  expect(document.body.textContent).not.toContain("linked run");
  await act(async () => button("Rerun failed questions").click());
  expect(command).toHaveBeenCalledExactlyOnceWith("runs.retry-failed", {
    runId: "run",
    expectedExecutionId: "execution-one",
    idempotencyKey: expect.any(String),
    acknowledgeDuplicateWork: false,
  });
  expect(onAcknowledged).toHaveBeenCalledExactlyOnceWith({
    run: { id: "run" },
  });
  expect(sessionStorage.length).toBe(0);
});
it.each(["retry", "resume"])(
  "restores an uncertain %s request after remount and replays the identical request after eligibility changes",
  async (operation) => {
    command.mockRejectedValueOnce(new Error("Response lost"));
    await act(async () => root.render(<Harness />));
    if (operation === "retry") {
      await act(async () => button("Rerun failed questions (1)").click());
      await act(async () => button("Rerun failed questions").click());
    } else await act(async () => button("Resume").click());
    const original = structuredClone(command.mock.calls[0]);
    expect(sessionStorage.length).toBe(1);
    await act(async () => root.render(<div />));
    const changed = view(false);
    changed.retryEligibility!.resultIds = [];
    changed.retryEligibility!.requiresAcknowledgment = true;
    changed.run.execution!.id = "execution-two";
    await act(async () => root.render(<Harness current={changed} />));
    command.mockResolvedValue({ run: { id: "run" } });
    await act(async () => button("Check recovery request").click());
    expect(command.mock.calls[1]).toEqual(original);
    expect(onAcknowledged).toHaveBeenCalledOnce();
    expect(sessionStorage.length).toBe(0);
  },
);
it("does not submit paid work when storage fails or durable workspace identity is missing", async () => {
  const storage = sessionStorage;
  vi.stubGlobal("sessionStorage", {
    getItem: storage.getItem.bind(storage),
    setItem: () => {
      throw new Error("quota");
    },
    removeItem: storage.removeItem.bind(storage),
  });
  await act(async () => root.render(<Harness />));
  await act(async () => button("Rerun failed questions (1)").click());
  await act(async () => button("Rerun failed questions").click());
  expect(command).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("cannot save");
  vi.stubGlobal("sessionStorage", storage);
  await act(async () => root.render(<div />));
  await act(async () => root.render(<Harness workspaceId="" />));
  expect(button("Rerun failed questions (1)").disabled).toBe(true);
  expect(container.textContent).toContain("Workspace identity is unavailable");
});
it("shares one pending request between Resume and retry and retains it after leaving the page", async () => {
  let reject!: (cause: Error) => void;
  command.mockReturnValue(
    new Promise((_resolve, fail) => {
      reject = fail;
    }),
  );
  await act(async () => root.render(<Harness />));
  await act(async () => button("Rerun failed questions (1)").click());
  await act(async () => button("Rerun failed questions").click());
  await act(async () => button("Resume").click());
  expect(command).toHaveBeenCalledOnce();
  await act(async () => root.render(<div />));
  await act(async () => reject(new Error("Response lost")));
  expect(sessionStorage.length).toBe(1);
  expect(onAcknowledged).not.toHaveBeenCalled();
});
it("isolates pending work by workspace and Run", async () => {
  command.mockRejectedValue(new Error("Response lost"));
  await act(async () => root.render(<Harness />));
  await act(async () => button("Resume").click());
  await act(async () =>
    root.render(<Harness workspaceId="another-workspace" />),
  );
  expect(container.textContent).not.toContain("Check recovery request");
  await act(async () => root.render(<Harness />));
  expect(container.textContent).toContain("Check recovery request");
  const another = view();
  another.run.id = "another-run";
  await act(async () => root.render(<Harness current={another} />));
  expect(container.textContent).not.toContain("Check recovery request");
});

it("blocks new admission when the saved request is malformed", async () => {
  sessionStorage.setItem("aeh.run-recovery.v1:workspace:run", "{broken");
  await act(async () => root.render(<Harness />));
  expect(container.textContent).toContain(
    "cannot read its saved recovery request",
  );
  expect(button("Rerun failed questions (1)").disabled).toBe(true);
  await act(async () => button("Resume").click());
  expect(command).not.toHaveBeenCalled();
  expect(sessionStorage.getItem("aeh.run-recovery.v1:workspace:run")).toBe(
    "{broken",
  );
});
it("replays the exact parsed saved subset and acknowledgment instead of later eligibility", async () => {
  const saved = {
    operation: "runs.retry-failed",
    input: {
      runId: "run",
      resultIds: ["specific-slot"],
      acknowledgeDuplicateWork: true,
      expectedExecutionId: "older-execution",
      idempotencyKey: "same-request",
    },
  };
  sessionStorage.setItem(
    "aeh.run-recovery.v1:workspace:run",
    JSON.stringify(saved),
  );
  command.mockResolvedValue({ run: { id: "run" } });
  await act(async () => root.render(<Harness current={view(false)} />));
  await act(async () => button("Check recovery request").click());
  expect(command).toHaveBeenCalledExactlyOnceWith(saved.operation, saved.input);
});
it("shows known acceptance when receipt cleanup fails and safely checks the same request", async () => {
  command.mockResolvedValue({ run: { id: "run" } });
  const storage = sessionStorage;
  vi.stubGlobal("sessionStorage", {
    getItem: storage.getItem.bind(storage),
    setItem: storage.setItem.bind(storage),
    removeItem: () => {
      throw new Error("storage unavailable");
    },
  });
  await act(async () => root.render(<Harness />));
  await act(async () => button("Resume").click());
  expect(onAcknowledged).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("Recovery was accepted");
  const request = structuredClone(command.mock.calls[0]);
  await act(async () => button("Resume").click());
  expect(command).toHaveBeenCalledOnce();
  vi.stubGlobal("sessionStorage", storage);
  await act(async () => button("Check recovery request").click());
  expect(command.mock.calls[1]).toEqual(request);
  expect(onAcknowledged).toHaveBeenCalledOnce();
  expect(sessionStorage.length).toBe(0);
});
it("does not let a late acknowledgment delete a newer pending request", async () => {
  const finish: Array<(value: unknown) => void> = [];
  command.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish.push(resolve);
      }),
  );
  await act(async () => root.render(<Harness />));
  await act(async () => button("Rerun failed questions (1)").click());
  await act(async () => button("Rerun failed questions").click());
  await act(async () => root.render(<div />));
  await act(async () => root.render(<Harness />));
  await act(async () => button("Check recovery request").click());
  await act(async () => finish[1]!({ run: { id: "run" } }));
  await act(async () => button("Rerun failed questions (1)").click());
  await act(async () => button("Rerun failed questions").click());
  const saved = sessionStorage.getItem("aeh.run-recovery.v1:workspace:run");
  expect(JSON.parse(saved!).input).toEqual(command.mock.calls[2]![1]);
  await act(async () => finish[0]!({ run: { id: "run" } }));
  expect(sessionStorage.getItem("aeh.run-recovery.v1:workspace:run")).toBe(
    saved,
  );
  await act(async () => finish[2]!({ run: { id: "run" } }));
  expect(sessionStorage.length).toBe(0);
});
it("offers an explicit warned exit after a stale rejection without changing default replay", async () => {
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  command.mockRejectedValue(
    Object.assign(new Error("The execution changed. Refresh and try again."), {
      status: 409,
    }),
  );
  await act(async () => root.render(<Harness />));
  await act(async () => button("Rerun failed questions (1)").click());
  await act(async () => button("Rerun failed questions").click());
  const original = structuredClone(command.mock.calls[0]);
  const current = view();
  current.run.execution!.id = "current-execution";
  await act(async () => root.render(<Harness current={current} />));
  expect(container.textContent).toContain("The execution changed");
  await act(async () => button("Check recovery request").click());
  expect(command.mock.calls[1]).toEqual(original);
  await act(async () => button("Discard saved request").click());
  expect(confirm).toHaveBeenCalledWith(
    expect.stringContaining("repeat remote work"),
  );
  expect(sessionStorage.length).toBe(1);
  expect(command).toHaveBeenCalledTimes(2);
  confirm.mockReturnValue(true);
  await act(async () => button("Discard saved request").click());
  expect(sessionStorage.length).toBe(0);
  expect(command).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  command.mockResolvedValue({ run: { id: "run" } });
  await act(async () => button("Rerun failed questions (1)").click());
  await act(async () => button("Rerun failed questions").click());
  expect(command.mock.calls[2]![1]).toMatchObject({
    expectedExecutionId: "current-execution",
  });
  expect(command.mock.calls[2]![1].idempotencyKey).not.toBe(
    original![1].idempotencyKey,
  );
});
it("lets the user explicitly discard a readable malformed record and then admit fresh work", async () => {
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  sessionStorage.setItem("aeh.run-recovery.v1:workspace:run", "{broken");
  await act(async () => root.render(<Harness />));
  await act(async () => button("Discard saved request").click());
  expect(sessionStorage.length).toBe(0);
  expect(command).not.toHaveBeenCalled();
  command.mockResolvedValue({ run: { id: "run" } });
  await act(async () => button("Rerun failed questions (1)").click());
  await act(async () => button("Rerun failed questions").click());
  expect(command).toHaveBeenCalledOnce();
});
it("keeps admission blocked when discarding saved data fails", async () => {
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  const storage = sessionStorage;
  storage.setItem("aeh.run-recovery.v1:workspace:run", "{broken");
  vi.stubGlobal("sessionStorage", {
    getItem: storage.getItem.bind(storage),
    removeItem: () => {
      throw new Error("storage unavailable");
    },
  });
  await act(async () => root.render(<Harness />));
  await act(async () => button("Discard saved request").click());
  expect(container.textContent).toContain("could not discard");
  expect(button("Rerun failed questions (1)").disabled).toBe(true);
  expect(storage.getItem("aeh.run-recovery.v1:workspace:run")).toBe("{broken");
  expect(command).not.toHaveBeenCalled();
});
it("does not discard a newer saved request through a stale notice", async () => {
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  const key = "aeh.run-recovery.v1:workspace:run";
  sessionStorage.setItem(key, "{broken");
  await act(async () => root.render(<Harness />));
  const newer = JSON.stringify({
    operation: "runs.retry-failed",
    input: {
      runId: "run",
      acknowledgeDuplicateWork: false,
      idempotencyKey: "newer-request",
    },
  });
  sessionStorage.setItem(key, newer);
  await act(async () => button("Discard saved request").click());
  expect(sessionStorage.getItem(key)).toBe(newer);
  expect(container.textContent).toContain("saved recovery request changed");
  expect(button("Check recovery request")).toBeDefined();
  expect(command).not.toHaveBeenCalled();
});
it("cannot discard an unreadable storage record or admit work", async () => {
  vi.stubGlobal("sessionStorage", {
    getItem: () => {
      throw new Error("storage unavailable");
    },
  });
  await act(async () => root.render(<Harness />));
  expect(container.textContent).toContain("Restore browser storage");
  expect(container.textContent).not.toContain("Discard saved request");
  await act(async () => button("Resume").click());
  expect(command).not.toHaveBeenCalled();
});
it("requires fresh acknowledgment for each new recovery while preserving an uncertain request's replay", async () => {
  const first = view();
  first.retryEligibility!.requiresAcknowledgment = true;
  command.mockResolvedValue({ run: { id: "run" } });
  await act(async () => root.render(<Harness current={first} />));
  await act(async () => button("Rerun failed questions (1)").click());
  let checkbox = document.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  )!;
  expect(checkbox.checked).toBe(false);
  expect(button("Rerun failed questions").disabled).toBe(true);
  await act(async () => checkbox.click());
  await act(async () => button("Rerun failed questions").click());
  expect(command.mock.calls[0]![1].acknowledgeDuplicateWork).toBe(true);
  const second = view();
  second.run.execution!.id = "execution-two";
  second.retryEligibility!.requiresAcknowledgment = true;
  await act(async () => root.render(<Harness current={second} />));
  await act(async () => button("Rerun failed questions (1)").click());
  checkbox = document.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  )!;
  expect(checkbox.checked).toBe(false);
  expect(button("Rerun failed questions").disabled).toBe(true);
  command.mockRejectedValueOnce(new Error("Response lost"));
  await act(async () => checkbox.click());
  await act(async () => button("Rerun failed questions").click());
  const pending = structuredClone(command.mock.calls[1]);
  expect(pending![1].acknowledgeDuplicateWork).toBe(true);
  expect(pending![1].idempotencyKey).not.toBe(
    command.mock.calls[0]![1].idempotencyKey,
  );
  expect(pending![1].expectedExecutionId).toBe("execution-two");
  await act(async () => button("Check recovery request").click());
  expect(command.mock.calls[2]).toEqual(pending);
});
