// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RunView, WorkspaceView } from "../contracts.js";
import { Observe } from "./observe.js";

const { command, observed, refresh } = vi.hoisted(() => ({
  command: vi.fn(),
  observed: { view: null as RunView | null },
  refresh: vi.fn(),
}));
vi.mock("./api.js", () => ({
  command,
  useResource: () => ({ data: null, error: null }),
}));
vi.mock("./observation-stream.js", () => ({
  useObservation: () => ({ data: observed.view, refresh }),
}));
vi.mock("./observation-questions.js", () => ({
  RunQuestions: () => null,
  matchesQuestionFilter: vi.fn(),
}));
vi.mock("./research-observation.js", () => ({
  ResearchPanel: ({ sessionId }: { sessionId: string }) => (
    <div>Research {sessionId}</div>
  ),
}));
let root: Root, container: HTMLDivElement;
const workspace = { workspaceId: "workspace" } as WorkspaceView;
function button(label: string) {
  const found = Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
const pass = (id: string) => ({
  id,
  name: id,
  source: "deterministic",
  status: "completed",
  coverage: {
    eligible: 1,
    answered: 0,
    judged: 0,
    correct: 0,
    incorrect: 0,
    errors: 0,
    unjudged: 1,
    reviewed: 0,
    overridden: 0,
  },
  accuracy: null,
});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.clear();
  command.mockReset();
  refresh.mockReset();
  observed.view = {
    run: {
      id: "run",
      name: "Original Run",
      status: "halted",
      researchSessionId: "past-research",
      createdAt: "2026-11-01",
      execution: { id: "execution" },
      manifest: { bank: { name: "Bank" }, repetitions: 1, questions: [] },
    },
    controllingJob: { kind: "run", id: "run", allowedActions: ["resume"] },
    allowedActions: [],
    attempts: [{ status: "failed", remoteCompletion: "unknown" }],
    progress: { completed: 0, total: 1, failed: 1 },
    results: [],
    retryEligibility: {
      available: true,
      resultIds: ["r1"],
      requiresAcknowledgment: true,
    },
    resumeEligibility: {
      available: true,
      resultIds: ["r1"],
      requiresAcknowledgment: true,
    },
    assessmentPasses: [pass("older"), pass("current")],
    selectedAssessmentPassId: "current",
  } as unknown as RunView;
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
it.each(["resume", "retry"])(
  "uses the current Run owner and clears a historical score override after %s acknowledgment",
  async (action) => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    command.mockResolvedValue(observed.view);
    await act(async () =>
      root.render(
        <Observe
          runId="run"
          sessionId="past-research"
          workspace={workspace}
          initialAssessmentId="older"
          refreshWorkspace={() => {}}
        />,
      ),
    );
    expect(
      container.querySelector(".selected-score-identity h2")?.textContent,
    ).toBe("older");
    expect(button("Resume")).toBeDefined();
    if (action === "resume") await act(async () => button("Resume").click());
    else {
      await act(async () => button("Rerun failed questions (1)").click());
      const checkbox = document.querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      )!;
      await act(async () => checkbox.click());
      await act(async () => button("Rerun failed questions").click());
    }
    expect(command).toHaveBeenCalledExactlyOnceWith(
      action === "resume" ? "runs.control" : "runs.retry-failed",
      expect.objectContaining({
        runId: "run",
        expectedExecutionId: "execution",
        idempotencyKey: expect.any(String),
        acknowledgeDuplicateWork: true,
      }),
    );
    if (action === "resume") expect(confirm).toHaveBeenCalledOnce();
    expect(
      container.querySelector(".selected-score-identity h2")?.textContent,
    ).toBe("current");
    expect(refresh).toHaveBeenCalledOnce();
    expect(button("Research")).toBeDefined();
  },
);
it("uses Research controls only for the current research owner", async () => {
  observed.view!.controllingJob = {
    kind: "research",
    id: "active-research",
    status: "paused",
    allowedActions: ["resume"],
  };
  await act(async () =>
    root.render(
      <Observe runId="run" workspace={workspace} refreshWorkspace={() => {}} />,
    ),
  );
  expect(container.textContent).not.toContain("Resume");
  await act(async () => button("Research controls").click());
  expect(container.textContent).toContain("Research active-research");
});
it("uses engine Resume acknowledgment rather than unrelated historical uncertainty", async () => {
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  observed.view!.resumeEligibility!.requiresAcknowledgment = false;
  command.mockResolvedValue(observed.view);
  await act(async () =>
    root.render(
      <Observe runId="run" workspace={workspace} refreshWorkspace={() => {}} />,
    ),
  );
  await act(async () => button("Resume").click());
  expect(confirm).not.toHaveBeenCalled();
  expect(command).toHaveBeenCalledExactlyOnceWith(
    "runs.control",
    expect.objectContaining({ acknowledgeDuplicateWork: false }),
  );
});
it("preserves a later score choice when recovery settles", async () => {
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  command.mockResolvedValue(observed.view);
  await act(async () =>
    root.render(
      <Observe
        runId="run"
        workspace={workspace}
        initialAssessmentId="older"
        refreshWorkspace={() => {}}
      />,
    ),
  );
  await act(async () => button("Resume").click());
  const selector = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Saved score"]',
  )!;
  await act(async () => {
    selector.value = "older";
    selector.dispatchEvent(new Event("change", { bubbles: true }));
  });
  observed.view = {
    ...observed.view!,
    run: { ...observed.view!.run, status: "completed" },
    selectedAssessmentPassId: "current",
  };
  await act(async () =>
    root.render(
      <Observe
        runId="run"
        workspace={workspace}
        initialAssessmentId="older"
        refreshWorkspace={() => {}}
      />,
    ),
  );
  expect(
    container.querySelector(".selected-score-identity h2")?.textContent,
  ).toBe("older");
  expect(command.mock.calls.map((call) => call[0])).toEqual([
    "runs.control",
    "runs.select-assessment",
  ]);
});
