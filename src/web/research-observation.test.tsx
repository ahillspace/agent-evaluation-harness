// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { researchSchema, type ResearchView } from "../contracts.js";
import { ResearchPanel } from "./research-observation.js";

let root: Root;
let container: HTMLDivElement;
let view: ResearchView;
let reads: Array<{
  input: { sessionId: string; index: number };
  signal: AbortSignal | null | undefined;
  resolve: (response: Response) => void;
}>;
const request = vi.fn();
const turn = (index: number) => ({
  createdAt: "2026-11-14T00:00:00Z",
  input: `TURN_${index}_RAW_INPUT`,
  output: {
    conversationId: "saved-conversation",
    message: `TURN_${index}_RAW_OUTPUT`,
    transcript: { marker: `TURN_${index}_RAW_TRANSCRIPT` },
  },
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const agent = { harness: "codex", model: "fixture" };
  view = {
    session: {
      id: "session-a",
      name: "Saved research",
      createdAt: "2026-11-14T00:00:00Z",
      updatedAt: "2026-11-14T00:00:00Z",
      status: "completed",
      intent: "run",
      phase: "finished",
      baselineRunId: "run",
      currentRunId: "run",
      bestRunId: "run",
      runIds: ["run"],
      configuration: researchSchema.parse({
        name: "Saved research",
        baseline: { bankRevisionId: "bank", agent },
        researcher: agent,
        objective: "Accuracy",
      }),
      turns: [0, 1].map((index) => ({
        createdAt: turn(index).createdAt,
        output: {
          conversationId: "saved-conversation",
          message: `Decision ${index}`,
        },
      })),
    },
    allowedActions: [],
    events: [],
    cursor: 0,
  };
  reads = [];
  request.mockReset();
  request.mockImplementation(async (url: string, options: RequestInit) => {
    if (url.endsWith("/research.get")) return Response.json(view);
    if (url.endsWith("/research.turn"))
      return new Promise<Response>((resolve) => {
        reads.push({
          input: JSON.parse(options.body as string),
          signal: options.signal,
          resolve,
        });
      });
    throw new Error(`Unexpected operation: ${url}`);
  });
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
const render = async (sessionId = "session-a", selectedRunId = "run") =>
  act(async () => {
    root.render(
      <ResearchPanel sessionId={sessionId} selectedRunId={selectedRunId} />,
    );
  });
const inspect = async (index: number) =>
  act(async () => {
    container
      .querySelectorAll<HTMLButtonElement>(".research-turn button")
      .item(index)!
      .click();
  });
const dialog = () => document.querySelector<HTMLDialogElement>("dialog");
const close = async () =>
  act(async () => {
    document
      .querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!
      .click();
  });
const respond = async (
  index: number,
  response = Response.json(turn(reads[index]!.input.index)),
) => act(async () => reads[index]!.resolve(response));
const unavailable = () =>
  Response.json(
    { error: { message: "Saved turn unavailable" } },
    { status: 503 },
  );

const runNavigation = () =>
  container.querySelector<HTMLElement>(".research-candidate-row")!;
const runSelector = () =>
  runNavigation().querySelector<HTMLSelectElement>("select");
const retainedLink = () =>
  runNavigation().querySelector<HTMLAnchorElement>("a");
const addCandidate = () => {
  view.session.runIds.push("candidate-1");
  view.session.currentRunId = "candidate-1";
};

const intentCaption = () =>
  container.querySelector(".research-turn .subtle")?.textContent;

type IntentOutput = ResearchView["session"]["turns"][number]["output"];
it.each<{
  name: string;
  output: Partial<IntentOutput>;
  caption: string;
}>([
  {
    name: "modern keep and stop",
    output: { disposition: "keep", control: "stop" },
    caption: "Recommends keeping · Requests stop",
  },
  {
    name: "modern discard and continue",
    output: { disposition: "discard", control: "continue" },
    caption: "Recommends discarding · Requests continuation",
  },
  {
    name: "modern keep overrides legacy discard",
    output: { disposition: "keep", decision: "discard" },
    caption: "Recommends keeping · Control unspecified",
  },
  {
    name: "modern discard overrides legacy keep",
    output: { disposition: "discard", decision: "keep" },
    caption: "Recommends discarding · Control unspecified",
  },
  {
    name: "modern continuation overrides legacy stop",
    output: { control: "continue", decision: "stop" },
    caption: "Retention unspecified · Requests continuation",
  },
  {
    name: "modern stop preserves legacy keep",
    output: { control: "stop", decision: "keep" },
    caption: "Recommends keeping · Requests stop",
  },
  {
    name: "legacy keep has no explicit control",
    output: { decision: "keep" },
    caption: "Recommends keeping · Control unspecified",
  },
  {
    name: "legacy discard has no explicit control",
    output: { decision: "discard" },
    caption: "Recommends discarding · Control unspecified",
  },
  {
    name: "legacy stop has no retention choice",
    output: { decision: "stop" },
    caption: "Retention unspecified · Requests stop",
  },
  {
    name: "absent choices remain unspecified",
    output: {},
    caption: "Retention unspecified · Control unspecified",
  },
  {
    name: "a blocker reports researcher intent",
    output: { control: "stop", stopCategory: "blocked" },
    caption:
      "Retention unspecified · Requests stop · Reports a technical blocker",
  },
  {
    name: "a blocker does not turn continuation into a stop",
    output: { control: "continue", stopCategory: "blocked" },
    caption:
      "Retention unspecified · Requests continuation · Reports a technical blocker",
  },
])("presents $name as researcher intent", async ({ output, caption }) => {
  view.session.turns = [
    {
      createdAt: turn(0).createdAt,
      output: {
        conversationId: "saved-conversation",
        message: "Recorded researcher response",
        ...output,
      },
    },
  ];
  await render();
  expect(intentCaption()).toBe(caption);
  expect(
    container
      .querySelector(".research-turn")
      ?.parentElement?.querySelector("h3")?.textContent,
  ).toBe("Researcher intent");
  expect(runNavigation().textContent).toContain(
    "Baseline · retained · current",
  );
  expect(reads).toHaveLength(0);
});

it("names the sole baseline and its saved facts without redundant navigation", async () => {
  await render();
  expect(runSelector()).toBeNull();
  expect(runNavigation().textContent).toContain("Research run");
  expect(runNavigation().textContent).toContain(
    "Baseline · retained · current",
  );
  expect(retainedLink()).toBeNull();
  expect(reads).toHaveLength(0);
});

it("preserves ordered research choices, selected identity, and session routing", async () => {
  addCandidate();
  view.session.runIds.push("candidate-2");
  view.session.currentRunId = "candidate-2";
  view.session.bestRunId = "candidate-1";
  await render("session-a", "candidate-2");
  const selector = runSelector()!;
  expect(selector.getAttribute("aria-label")).toBe("Research run");
  expect(selector.value).toBe("candidate-2");
  expect(
    Array.from(selector.options, (option) => [option.value, option.text]),
  ).toEqual([
    ["run", "Baseline"],
    ["candidate-1", "Candidate 1 · retained"],
    ["candidate-2", "Candidate 2 · current"],
  ]);
  expect(retainedLink()?.textContent).toBe("Open retained candidate 1");
  expect(retainedLink()?.getAttribute("href")).toBe(
    "#/runs/candidate-1?session=session-a",
  );
  await act(async () => {
    selector.value = "run";
    selector.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(window.location.hash).toBe("#/runs/run?session=session-a");
  expect(
    request.mock.calls.every(([url]) => url.endsWith("/research.get")),
  ).toBe(true);
});

it("omits the retained shortcut only when its run is already selected", async () => {
  addCandidate();
  await render();
  expect(retainedLink()).toBeNull();
  await render("session-a", "candidate-1");
  expect(retainedLink()?.textContent).toBe("Open retained baseline");
  expect(retainedLink()?.getAttribute("href")).toBe(
    "#/runs/run?session=session-a",
  );
  view.session.bestRunId = "candidate-1";
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(retainedLink()).toBeNull();
  expect(runSelector()?.value).toBe("candidate-1");
});

it("turns a newly extended session into a chooser without changing the viewed baseline", async () => {
  await render();
  expect(runSelector()).toBeNull();
  addCandidate();
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(runSelector()?.value).toBe("run");
  expect(Array.from(runSelector()!.options, (option) => option.text)).toEqual([
    "Baseline · retained",
    "Candidate 1 · current",
  ]);
  expect(retainedLink()).toBeNull();
  expect(reads).toHaveLength(0);
});

it("does not claim an unrelated viewed run is the selected research candidate", async () => {
  addCandidate();
  await render("session-a", "unrelated-run");
  const selector = runSelector()!;
  expect(selector.value).toBe("");
  expect(selector.selectedOptions[0]?.text).toBe("Choose a research run");
  expect(selector.selectedOptions[0]?.disabled).toBe(true);
  expect(retainedLink()?.getAttribute("href")).toBe(
    "#/runs/run?session=session-a",
  );
});

it("identifies the available sole run without relabeling an unrelated viewed run", async () => {
  await render("session-a", "unrelated-run");
  expect(runSelector()).toBeNull();
  expect(runNavigation().textContent).toContain("Available research run");
  expect(runNavigation().textContent).toContain(
    "Baseline · retained · current",
  );
  expect(retainedLink()?.getAttribute("href")).toBe(
    "#/runs/run?session=session-a",
  );
});

it("shows an empty initialization honestly without constructing an empty run link", async () => {
  view.session.runIds = [];
  view.session.baselineRunId = "";
  view.session.currentRunId = "";
  view.session.bestRunId = "";
  await render("session-a", "unrelated-run");
  expect(runSelector()).toBeNull();
  expect(retainedLink()).toBeNull();
  expect(runNavigation().textContent).toContain(
    "No research runs recorded yet.",
  );
});

it("keeps the latest requested turn when earlier raw evidence arrives last", async () => {
  await render();
  await inspect(0);
  await inspect(1);
  await respond(1);
  await respond(0);
  expect(dialog()?.textContent).toContain("TURN_1_RAW_TRANSCRIPT");
  expect(dialog()?.textContent).not.toContain("TURN_0_RAW_TRANSCRIPT");
});

it("opens a numbered loading dialog immediately without reading other turns", async () => {
  await render();
  expect(reads).toHaveLength(0);
  await inspect(1);
  expect(dialog()?.textContent).toContain("Recorded researcher turn 2");
  expect(dialog()?.textContent).toContain(
    "Loading recorded researcher turn...",
  );
  expect(reads.map(({ input }) => input)).toEqual([
    { sessionId: "session-a", index: 1 },
  ]);
  await respond(0);
  expect(dialog()?.textContent).toContain("TURN_1_RAW_INPUT");
  expect(dialog()?.textContent).toContain("TURN_1_RAW_OUTPUT");
});

it.each(["success", "error"])(
  "closing pending inspection ignores late %s even when fetch ignores abort",
  async (outcome) => {
    await render();
    await inspect(0);
    await close();
    expect(reads[0]!.signal?.aborted).toBe(true);
    await respond(
      0,
      outcome === "success" ? Response.json(turn(0)) : unavailable(),
    );
    expect(dialog()).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  },
);

it.each(["success", "error"])(
  "replacing a closed pending turn ignores late %s",
  async (outcome) => {
    await render();
    await inspect(0);
    await close();
    await inspect(1);
    await respond(1);
    await respond(
      0,
      outcome === "success" ? Response.json(turn(0)) : unavailable(),
    );
    expect(dialog()?.textContent).toContain("Recorded researcher turn 2");
    expect(dialog()?.textContent).toContain("TURN_1_RAW_TRANSCRIPT");
    expect(document.querySelector('[role="alert"]')).toBeNull();
  },
);

it("keeps errors and explicit retry inside the selected turn dialog", async () => {
  await render();
  await inspect(1);
  await respond(0, unavailable());
  expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
    "Saved turn unavailable",
  );
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(4500));
  expect(reads).toHaveLength(1);
  await act(async () => {
    Array.from(dialog()!.querySelectorAll("button"))
      .find((button) => button.textContent === "Retry")!
      .click();
  });
  expect(reads[0]!.signal?.aborted).toBe(true);
  expect(reads.map(({ input }) => input.index)).toEqual([1, 1]);
  await respond(1);
  expect(dialog()?.textContent).toContain("TURN_1_RAW_TRANSCRIPT");
  expect(dialog()?.querySelector('[role="alert"]')).toBeNull();
});

it("preserves the selected turn across appended observation summaries without polling its detail", async () => {
  await render();
  await inspect(0);
  await respond(0);
  view.session.turns.push({
    createdAt: turn(2).createdAt,
    output: { conversationId: "saved-conversation", message: "Decision 2" },
  });
  await act(async () => vi.advanceTimersByTimeAsync(4500));
  expect(container.querySelectorAll(".research-turn")).toHaveLength(3);
  expect(dialog()?.textContent).toContain("Recorded researcher turn 1");
  expect(dialog()?.textContent).toContain("TURN_0_RAW_TRANSCRIPT");
  expect(reads).toHaveLength(1);
});

it.each(["success", "error"])(
  "session changes discard pending inspection and late %s",
  async (outcome) => {
    await render();
    await inspect(0);
    view.session.id = "session-b";
    await render("session-b");
    expect(reads[0]!.signal?.aborted).toBe(true);
    await respond(
      0,
      outcome === "success" ? Response.json(turn(0)) : unavailable(),
    );
    expect(dialog()).toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await inspect(1);
    expect(reads[1]!.input).toEqual({ sessionId: "session-b", index: 1 });
  },
);

it.each(["success", "error"])(
  "owner unmount cancels inspection and ignores late %s",
  async (outcome) => {
    await render();
    await inspect(0);
    await act(async () => root.render(null));
    expect(reads[0]!.signal?.aborted).toBe(true);
    await respond(
      0,
      outcome === "success" ? Response.json(turn(0)) : unavailable(),
    );
    expect(dialog()).toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  },
);
