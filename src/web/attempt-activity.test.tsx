// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AssessmentPassObservation, RunView } from "../contracts.js";
import { RunQuestions } from "./observation-questions.js";

let root: Root;
let container: HTMLDivElement;
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
function view(runId = "run", running = false): RunView {
  return {
    run: {
      id: runId,
      status: running ? "running" : "completed",
      manifest: {
        target: { kind: "managed", agent: {} },
        bank: { id: "bank" },
        evaluator: { id: "eval", settings: {} },
        questions: [
          { id: "q1", text: "First?", expected: 42 },
          { id: "q2", text: "Second?", expected: 42 },
        ],
      },
    },
    results: ["r1", "r2"].map((id, index) => ({
      id,
      runId,
      questionId: `q${index + 1}`,
      repetition: 1,
      status: running ? "running" : "completed",
      attemptIds: [`${runId}-${id}`],
      completedAttemptId: `${runId}-${id}`,
    })),
    attempts: ["r1", "r2", "alternate"].map((id) => ({
      id: `${runId}-${id}`,
      runId,
      resultId: id === "alternate" ? "r1" : id,
      number: id === "alternate" ? 2 : 1,
      status: running ? "running" : "completed",
      hasOutput: !running,
      evidenceHash: running ? undefined : `sealed-${id}`,
      startedAt: "2026-11-01T00:00:00Z",
    })),
    progress: { completed: running ? 0 : 2, total: 2, failed: 0 },
    jevAssessments: [],
  } as unknown as RunView;
}
async function render(
  value = view(),
  selected = "r1",
  pass?: AssessmentPassObservation,
) {
  await act(async () =>
    root.render(
      <RunQuestions
        view={value}
        pass={pass}
        selectedResultId={selected}
        onSelectResult={() => {}}
        onReview={() => {}}
      />,
    ),
  );
}
async function tab(name: string) {
  await act(async () =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((item) => item.textContent === name)!
      .click(),
  );
}
const event = (sequence: number, attemptId: string) => ({
  sequence,
  attemptId,
  createdAt: "2026-11-01T00:00:00Z",
  type: "agent.message",
  message: `${attemptId}-marker-${sequence}`,
  data: { full: `data-${sequence}` },
});
function requests(
  handler: (
    input: { attemptId: string; cursor: number },
    options: RequestInit,
  ) => Promise<Response>,
) {
  const events = vi.fn(handler);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      const input = JSON.parse(options.body as string);
      if (url.endsWith("/runs.attempt-events")) return events(input, options);
      if (url.endsWith("/runs.attempt"))
        return Response.json({
          attempt: {
            output: { answer: 42, text: "42", transcript: { retained: true } },
          },
        });
      throw Error(`Unexpected request ${url}`);
    }),
  );
  return events;
}

it("loads Activity on demand, drains full pages through an empty terminal page, and retains it across tabs", async () => {
  const request = requests(async ({ attemptId, cursor }) => {
    const page =
      cursor < 400
        ? Array.from({ length: 200 }, (_, i) =>
            event(cursor + i + 1, attemptId),
          )
        : [];
    return Response.json({
      events: page,
      cursor: page.at(-1)?.sequence ?? cursor,
    });
  });
  await render();
  expect(container.textContent).toContain("42");
  expect(request).not.toHaveBeenCalled();
  await tab("Activity");
  await act(async () => vi.advanceTimersByTimeAsync(2));
  expect(request.mock.calls.map(([input]) => input.cursor)).toEqual([
    0, 200, 400,
  ]);
  expect(container.querySelectorAll(".event-list > .event")).toHaveLength(400);
  expect(container.textContent).toContain("run-r1-marker-1");
  expect(container.textContent).toContain("run-r1-marker-400");
  expect(container.textContent).toContain("data-400");
  await tab("Answer");
  await tab("Attempts");
  await tab("Activity");
  await act(async () => vi.advanceTimersByTimeAsync(1600));
  expect(request.mock.calls.map(([input]) => input.cursor)).toEqual([
    0, 200, 400, 400, 400,
  ]);
});

it("keeps the live cursor through settlement and retains final events without restarting", async () => {
  let settled = false;
  const request = requests(async ({ attemptId, cursor }) => {
    const page =
      cursor === 0
        ? [event(1, attemptId)]
        : settled && cursor === 1
          ? [event(2, attemptId)]
          : [];
    return Response.json({
      events: page,
      cursor: page.at(-1)?.sequence ?? cursor,
    });
  });
  await render(view("run", true));
  expect(container.textContent).toContain("run-r1-marker-1");
  settled = true;
  await render(view());
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(request.mock.calls.map(([input]) => input.cursor)).toEqual([0, 1]);
  expect(container.textContent).toContain("run-r1-marker-1");
  expect(container.textContent).toContain("run-r1-marker-2");
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(request.mock.calls.map(([input]) => input.cursor)).toEqual([0, 1, 2]);
});

it.each([false, true])(
  "keeps background polling quiet after initialized history, including empty=%s",
  async (empty) => {
    let resolve!: (response: Response) => void;
    const request = requests(async ({ attemptId }) => {
      if (request.mock.calls.length === 1)
        return Response.json({
          events: empty ? [] : [event(1, attemptId)],
          cursor: empty ? 0 : 1,
        });
      return new Promise<Response>((done) => {
        resolve = done;
      });
    });
    await render(view("run", true));
    expect(container.textContent).not.toContain("Loading activity...");
    const retained =
      container.querySelector(".event-list > .event") ??
      container.querySelector(".activity-body .waiting-text");
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(container.textContent).not.toContain("Loading activity...");
    expect(
      container.querySelector(".event-list > .event") ??
        container.querySelector(".activity-body .waiting-text"),
    ).toBe(retained);
    await act(async () =>
      resolve(Response.json({ events: [], cursor: empty ? 0 : 1 })),
    );
    expect(container.textContent).not.toContain("Loading activity...");
  },
);

it("incrementally discovers late saved grading events while a completed Run remains open or Activity reopens", async () => {
  let late = false;
  const request = requests(async ({ attemptId, cursor }) => {
    const events =
      cursor === 0
        ? [event(1, attemptId)]
        : late && cursor === 1
          ? [
              {
                ...event(2, attemptId),
                type: "judge.started",
                message: "Late saved judge started.",
              },
            ]
          : [];
    return Response.json({ events, cursor: events.at(-1)?.sequence ?? cursor });
  });
  await render();
  await tab("Activity");
  late = true;
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(container.textContent).toContain("Late saved judge started.");
  await tab("Answer");
  await tab("Activity");
  expect(request.mock.calls.map(([input]) => input.cursor)).toEqual([0, 1, 2]);
  expect(container.textContent).toContain("run-r1-marker-1");
});

it("resumes a canceled same-attempt backlog page and ignores its late result", async () => {
  let resolve!: (response: Response) => void;
  let continuations = 0;
  const request = requests(async ({ attemptId, cursor }) => {
    if (cursor === 0)
      return Response.json({
        events: Array.from({ length: 200 }, (_, i) => event(i + 1, attemptId)),
        cursor: 200,
      });
    if (++continuations === 1)
      return new Promise<Response>((done) => {
        resolve = done;
      });
    return Response.json({ events: [event(201, attemptId)], cursor: 201 });
  });
  await render();
  await tab("Activity");
  await act(async () => vi.advanceTimersByTimeAsync(1));
  const abandoned = request.mock.calls.at(-1)![1].signal!;
  await tab("Answer");
  expect(abandoned.aborted).toBe(true);
  await tab("Activity");
  expect(request.mock.calls.map(([input]) => input.cursor)).toEqual([
    0, 200, 200,
  ]);
  await act(async () =>
    resolve(
      Response.json({
        events: [
          {
            ...event(999, "run-r1"),
            message: "Canceled same-attempt sentinel",
          },
        ],
        cursor: 999,
      }),
    ),
  );
  expect(container.textContent).not.toContain("Canceled same-attempt sentinel");
  expect(container.textContent).toContain("run-r1-marker-201");
});

it("keeps a persistent transient error visible during automatic retries and leaves 4xx failures to explicit Retry", async () => {
  let resolve!: (response: Response) => void;
  let permanent = false;
  const request = requests(async ({ cursor }) => {
    if (request.mock.calls.length === 1)
      return Response.json({ events: [], cursor });
    if (request.mock.calls.length === 2 || permanent)
      return Response.json(
        {
          error: {
            message: permanent
              ? "Activity authorization changed"
              : "Activity temporarily unavailable",
          },
        },
        { status: permanent ? 403 : 503 },
      );
    return new Promise<Response>((done) => {
      resolve = done;
    });
  });
  await render(view("run", true));
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(container.textContent).toContain("Activity temporarily unavailable");
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(container.textContent).toContain("Activity temporarily unavailable");
  permanent = true;
  await act(async () =>
    resolve(
      Response.json(
        { error: { message: "Activity authorization changed" } },
        { status: 403 },
      ),
    ),
  );
  const count = request.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(4500));
  expect(request).toHaveBeenCalledTimes(count);
  expect(container.textContent).toContain("Retry loading activity");
});

it("automatically recovers a transient live activity failure from the retained cursor", async () => {
  let fail = true;
  const request = requests(async ({ attemptId, cursor }) => {
    if (cursor === 0)
      return Response.json({ events: [event(1, attemptId)], cursor: 1 });
    if (fail)
      return Response.json(
        { error: { message: "Transient live failure" } },
        { status: 503 },
      );
    return Response.json({ events: [event(2, attemptId)], cursor: 2 });
  });
  await render(view("run", true));
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(container.textContent).toContain("Transient live failure");
  fail = false;
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(request.mock.calls.map(([input]) => input.cursor)).toEqual([0, 1, 1]);
  expect(container.textContent).toContain("run-r1-marker-1");
  expect(container.textContent).toContain("run-r1-marker-2");
  expect(container.textContent).not.toContain("Transient live failure");
});

it("shows local loading and failure states and retries the failed continuation cursor", async () => {
  let resolve!: (value: Response) => void;
  let fail = true;
  const request = requests(async ({ attemptId, cursor }) => {
    if (cursor === 0)
      return new Promise<Response>((done) => {
        resolve = done;
      });
    if (fail)
      return Response.json(
        { error: { message: "Activity unavailable" } },
        { status: 503 },
      );
    return Response.json({ events: [event(201, attemptId)], cursor: 201 });
  });
  await render();
  await tab("Activity");
  expect(container.textContent).toContain("Loading activity...");
  expect(container.textContent).not.toContain("No recorded activity");
  await act(async () =>
    resolve(
      Response.json({
        events: Array.from({ length: 200 }, (_, i) => event(i + 1, "run-r1")),
        cursor: 200,
      }),
    ),
  );
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(container.textContent).toContain("Activity unavailable");
  expect(container.textContent).not.toContain("Loading activity...");
  fail = false;
  const retry = Array.from(
    container.querySelectorAll<HTMLButtonElement>("button"),
  ).find((e) => e.textContent === "Retry loading activity");
  expect(retry).toBeDefined();
  await act(async () => retry!.click());
  expect(request.mock.calls.map(([input]) => input.cursor)).toEqual([
    0, 200, 200,
  ]);
  expect(container.textContent).toContain("run-r1-marker-201");
  expect(container.textContent).not.toContain("Activity unavailable");
  await tab("Answer");
  expect(container.textContent).not.toContain("Retry loading activity");
});

it("cancels and isolates pending activity across question, recorded attempt, saved-score source, and Run changes", async () => {
  let resolve!: (value: Response) => void;
  const request = requests(async ({ attemptId }, options) => {
    if (attemptId === "run-r1")
      return new Promise<Response>((done) => {
        resolve = done;
      });
    expect(options.signal?.aborted).toBe(false);
    return Response.json({ events: [event(9, attemptId)], cursor: 9 });
  });
  await render();
  await tab("Activity");
  const abandoned = request.mock.calls[0]![1].signal!;
  await render(view(), "r2");
  expect(abandoned.aborted).toBe(true);
  await act(async () =>
    resolve(Response.json({ events: [event(1, "run-r1")], cursor: 1 })),
  );
  expect(container.textContent).not.toContain("run-r1-marker-1");
  expect(container.textContent).toContain("run-r2-marker-9");
  const pass = {
    judgments: [
      { resultId: "r1", attemptId: "run-alternate", status: "correct" },
    ],
    basis: {},
  } as unknown as AssessmentPassObservation;
  await render(view(), "r1", pass);
  expect(container.textContent).toContain("run-alternate-marker-9");
  expect(container.textContent).not.toContain("run-r2-marker-9");
  await tab("Attempts");
  const select = container.querySelector<HTMLSelectElement>(
    '[aria-label="Recorded attempt"]',
  )!;
  await act(async () => {
    select.value = "run-r1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await tab("Activity");
  expect(request.mock.calls.at(-1)![0]).toMatchObject({
    attemptId: "run-r1",
    cursor: 0,
  });
  const recordedRequest = request.mock.calls.at(-1)![1].signal!;
  await tab("Answer");
  expect(recordedRequest.aborted).toBe(true);
  await render(view("other"), "r1");
  expect(container.textContent).not.toContain("run-alternate-marker-9");
  expect(
    request.mock.calls.filter(([input]) => input.attemptId.startsWith("other")),
  ).toHaveLength(0);
  await tab("Activity");
  expect(container.textContent).toContain("other-r1-marker-9");
  await act(async () =>
    resolve(Response.json({ events: [event(3, "run-r1")], cursor: 3 })),
  );
  expect(container.textContent).not.toContain("run-r1-marker-3");
});
