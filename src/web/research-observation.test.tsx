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
const render = async (sessionId = "session-a") =>
  act(async () => {
    root.render(<ResearchPanel sessionId={sessionId} selectedRunId="run" />);
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
