// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AssessmentPassObservation, RunView } from "../contracts.js";
import { RunQuestions } from "./observation-questions.js";
import { ReviewDialog } from "./human-review.js";

let root: Root;
let container: HTMLDivElement;
const calls: Array<{
  operation: string;
  input: Record<string, string>;
  signal: AbortSignal;
}> = [];
let respond: (
  operation: string,
  input: Record<string, string>,
) => Response | Promise<Response>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  calls.length = 0;
  respond = (operation, input) => {
    if (operation === "runs.answer")
      return Response.json({
        attemptId: input.attemptId,
        evidenceHash: input.expectedEvidenceHash,
        answer: `ANSWER-${input.attemptId}`,
      });
    if (operation === "runs.attempt")
      return Response.json({
        attempt: {
          id: input.attemptId,
          output: { answer: 42, text: `RAW-${input.attemptId}` },
        },
        assessments: [{ response: "JUDGE-RAW" }],
      });
    if (operation === "runs.attempt-events")
      return Response.json({ events: [], cursor: 0 });
    if (operation === "runs.assessment")
      return Response.json({
        observationRevision: input.expectedObservationRevision,
        configuration: {},
      });
    throw Error(`Unexpected ${operation}`);
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      const operation = url.split("/").at(-1)!;
      const input = JSON.parse(options.body as string);
      calls.push({ operation, input, signal: options.signal as AbortSignal });
      return respond(operation, input);
    }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function view(): RunView {
  return {
    run: {
      id: "logical",
      status: "completed",
      manifest: {
        target: { kind: "managed", agent: {} },
        bank: {
          id: "bank",
          questions: [
            { id: "q1", text: "First?", expected: 42 },
            { id: "q2", text: "Second?", expected: null },
          ],
        },
        evaluator: { id: "eval", settings: {} },
        questions: [
          { id: "q1", text: "First?", expected: 42 },
          { id: "q2", text: "Second?", expected: null },
        ],
      },
    },
    results: ["r1", "r2"].map((id, i) => ({
      id,
      runId: "logical",
      questionId: `q${i + 1}`,
      repetition: 1,
      status: "completed",
      attemptIds: [`a${i + 1}`],
      completedAttemptId: `a${i + 1}`,
    })),
    attempts: ["a1", "a2", "older"].map((id, i) => ({
      id,
      runId: "logical",
      resultId: i === 1 ? "r2" : "r1",
      number: i + 1,
      status: "completed",
      hasOutput: true,
      evidenceHash: `hash-${id}`,
      startedAt: "2026-11-01T00:00:00Z",
    })),
    progress: { completed: 2, total: 2, failed: 0 },
    jevAssessments: [],
  } as unknown as RunView;
}
function pass(id = "score", answer = "a1"): AssessmentPassObservation {
  return {
    id,
    observationRevision: `revision-${id}`,
    name: id,
    source: "deterministic",
    basis: { bankRevisionId: "bank", evaluatorRevisionId: "eval" },
    coverage: { correct: 1, judged: 1, eligible: 2 },
    judgments: [
      {
        resultId: "r1",
        status: "correct",
        explanation: "Saved judgment",
        ...(answer
          ? { attemptId: answer, evidenceHash: `hash-${answer}` }
          : {}),
      },
    ],
  } as AssessmentPassObservation;
}
async function render(
  value = view(),
  selected = "r1",
  score?: AssessmentPassObservation,
) {
  await act(async () =>
    root.render(
      <RunQuestions
        view={value}
        pass={score}
        selectedResultId={selected}
        onSelectResult={() => {}}
        onInspectCapturedScore={() => {}}
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
async function disclosure(name: string, open = true) {
  await act(async () => {
    const summary = Array.from(document.querySelectorAll("summary")).find(
      (item) => item.textContent === name,
    )!;
    const details = summary.parentElement as HTMLDetailsElement;
    details.open = open;
    details.dispatchEvent(new Event("toggle"));
  });
}
function requested(operation: string) {
  return calls.filter((item) => item.operation === operation);
}

it("loads only the compact answer on Answer and full raw evidence only during the selected open disclosure", async () => {
  await render();
  expect(requested("runs.answer").map((item) => item.input)).toEqual([
    { runId: "logical", attemptId: "a1", expectedEvidenceHash: "hash-a1" },
  ]);
  expect(requested("runs.attempt")).toHaveLength(0);
  expect(container.textContent).toContain("ANSWER-a1");
  expect(container.textContent).not.toContain("RAW-a1");
  await disclosure("Original response text");
  expect(requested("runs.attempt")).toHaveLength(1);
  expect(container.textContent).toContain("RAW-a1");
  await disclosure("Original response text", false);
  expect(container.textContent).not.toContain("RAW-a1");
  await tab("Attempts");
  expect(requested("runs.attempt")).toHaveLength(1);
  await disclosure("Recorded attempt data");
  expect(requested("runs.attempt")).toHaveLength(2);
  expect(container.textContent).toContain("RAW-a1");
  expect(container.textContent).not.toContain("JUDGE-RAW");
  await render(view(), "r2");
  expect(container.textContent).not.toContain("RAW-a1");
  expect(requested("runs.attempt")).toHaveLength(2);
});

it("does not fetch completed bodies on Activity, including live settlement", async () => {
  const live = view();
  live.run.status = "running";
  await render(live);
  expect(requested("runs.answer")).toHaveLength(0);
  expect(requested("runs.attempt")).toHaveLength(0);
  await render();
  expect(requested("runs.answer")).toHaveLength(0);
  await tab("Answer");
  expect(requested("runs.answer")).toHaveLength(1);
});

it("retains failure transport text on visible Answer without fetching it on Activity", async () => {
  const failed = view();
  failed.attempts[0] = {
    ...failed.attempts[0]!,
    status: "failed",
    hasOutput: false,
    evidenceHash: undefined,
  };
  failed.results[0] = {
    ...failed.results[0]!,
    status: "failed",
    completedAttemptId: undefined,
  };
  failed.attempts = failed.attempts.slice(0, 2);
  respond = () =>
    Response.json({
      attempt: { failure: { transport: { text: "SAVED FAILURE TEXT" } } },
    });
  await render(failed);
  expect(container.textContent).toContain("SAVED FAILURE TEXT");
  expect(requested("runs.answer")).toHaveLength(0);
  await tab("Activity");
  expect(container.textContent).not.toContain("SAVED FAILURE TEXT");
  expect(requested("runs.attempt")).toHaveLength(1);
});

it("reports compact and raw errors with retry instead of indefinite loading", async () => {
  let fail = true;
  const normal = respond;
  respond = (op, input) =>
    fail
      ? Response.json(
          { error: { message: "Synthetic read failure" } },
          { status: 503 },
        )
      : normal(op, input);
  await render();
  expect(container.textContent).toContain("Synthetic read failure");
  expect(container.textContent).not.toContain("Loading saved answer...");
  fail = false;
  await act(async () =>
    Array.from(container.querySelectorAll("button"))
      .find((item) => item.textContent === "Retry loading answer")!
      .click(),
  );
  expect(container.textContent).toContain("ANSWER-a1");
  fail = true;
  await disclosure("Original response text");
  expect(container.textContent).toContain("Synthetic read failure");
  fail = false;
  await act(async () =>
    Array.from(container.querySelectorAll("button"))
      .find((item) => item.textContent === "Retry loading original response")!
      .click(),
  );
  expect(container.textContent).toContain("RAW-a1");
});

it("mounts complete failure diagnostics only while disclosed without rereading or hiding saved text", async () => {
  const failed = view();
  failed.results[0] = {
    ...failed.results[0]!,
    status: "failed",
    completedAttemptId: undefined,
  };
  failed.attempts = failed.attempts.slice(0, 2);
  failed.attempts[0] = {
    ...failed.attempts[0]!,
    status: "failed",
    hasOutput: false,
    evidenceHash: undefined,
  };
  respond = (_operation, input) =>
    Response.json({
      attempt: {
        failure: {
          transport: {
            text: `VISIBLE FAILURE ${input.attemptId}`,
            diagnostics: {
              request: `COMPLETE_DIAGNOSTIC_${input.attemptId}`,
              nested: { response: "COMPLETE_NESTED_RESPONSE" },
            },
          },
        },
      },
    });
  await render(failed);
  expect(container.textContent).toContain("VISIBLE FAILURE a1");
  expect(container.textContent).not.toContain("COMPLETE_DIAGNOSTIC_a1");
  await disclosure("Submission failure evidence");
  expect(container.textContent).toContain("COMPLETE_DIAGNOSTIC_a1");
  expect(container.textContent).toContain("COMPLETE_NESTED_RESPONSE");
  expect(container.textContent).toContain("VISIBLE FAILURE a1");
  await disclosure("Submission failure evidence", false);
  expect(container.textContent).not.toContain("COMPLETE_DIAGNOSTIC_a1");
  expect(container.textContent).not.toContain("COMPLETE_NESTED_RESPONSE");
  expect(container.textContent).toContain("VISIBLE FAILURE a1");
  expect(requested("runs.attempt")).toHaveLength(1);
  await disclosure("Submission failure evidence");
  failed.attempts[0] = { ...failed.attempts[0]!, id: "replacement" };
  await render(failed);
  expect(container.textContent).toContain("VISIBLE FAILURE replacement");
  expect(container.textContent).not.toContain("COMPLETE_DIAGNOSTIC_");
  const diagnostics = Array.from(container.querySelectorAll("details")).find(
    (item) =>
      item.querySelector("summary")?.textContent ===
      "Submission failure evidence",
  )!;
  expect(diagnostics.open).toBe(false);
  expect(requested("runs.attempt")).toHaveLength(2);
});

it.each(
  ["question", "pass", "attempt", "hash", "run", "close", "unmount"].flatMap(
    (change) => [true, false].map((success) => ({ change, success })),
  ),
)(
  "ignores late raw success=$success after $change changes even when fetch ignores cancellation",
  async ({ change, success }) => {
    const normal = respond;
    let complete!: (value: Response) => void;
    respond = (op, input) =>
      op === "runs.attempt"
        ? new Promise<Response>((resolve) => {
            complete = resolve;
          })
        : normal(op, input);
    await render(view(), "r1", pass());
    await disclosure("Original response text");
    const pending = requested("runs.attempt")[0]!;
    if (change === "question") await render(view(), "r2", pass());
    if (change === "pass") await render(view(), "r1", pass("other"));
    if (change === "hash") {
      const changed = view();
      changed.attempts[0]!.evidenceHash = "changed-hash";
      await render(changed, "r1", pass());
    }
    if (change === "run") {
      const changed = view();
      changed.run.id = "another-run";
      changed.results.forEach((item) => {
        item.runId = "another-run";
      });
      changed.attempts.forEach((item) => {
        item.runId = "another-run";
      });
      await render(changed, "r1", pass());
    }
    if (change === "attempt") {
      await tab("Attempts");
      await act(async () => {
        const select = container.querySelector<HTMLSelectElement>(
          '[aria-label="Recorded attempt"]',
        )!;
        select.value = "older";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
    if (change === "close") await disclosure("Original response text", false);
    if (change === "unmount") await act(async () => root.render(null));
    expect(pending.signal.aborted).toBe(true);
    await act(async () =>
      complete(
        success
          ? Response.json({ attempt: { output: { text: "STALE RAW" } } })
          : Response.json(
              { error: { message: "STALE ERROR" } },
              { status: 503 },
            ),
      ),
    );
    expect(document.body.textContent).not.toContain("STALE RAW");
    expect(document.body.textContent).not.toContain("STALE ERROR");
    expect(document.body.textContent).not.toContain("RAW-a1");
  },
);

it("retains immutable selected answer and open raw response through another judgment's observation revision", async () => {
  const score = pass();
  await render(view(), "r1", score);
  await disclosure("Original response text");
  expect(container.textContent).toContain("RAW-a1");
  await render(view(), "r1", {
    ...score,
    observationRevision: "new-other-question",
    coverage: { ...score.coverage, judged: 2 },
    judgments: [
      ...score.judgments,
      {
        resultId: "r2",
        status: "incorrect",
        explanation: "New other judgment",
      },
    ],
  });
  expect(requested("runs.answer")).toHaveLength(1);
  expect(requested("runs.attempt")).toHaveLength(1);
  expect(container.textContent).toContain("RAW-a1");
});

it("rejects a mismatched compact identity with a retryable error", async () => {
  respond = () =>
    Response.json({
      attemptId: "other",
      evidenceHash: "other",
      answer: "WRONG ANSWER",
    });
  await render();
  expect(container.textContent).not.toContain("WRONG ANSWER");
  expect(container.textContent).toContain(
    "does not match the selected sealed evidence",
  );
  expect(
    Array.from(container.querySelectorAll("button")).some(
      (item) => item.textContent === "Retry loading answer",
    ),
  ).toBe(true);
});

it.each([null, false, 0, ""])(
  "renders a saved falsey JSON answer %j",
  async (answer) => {
    respond = (_op, input) =>
      Response.json({
        attemptId: input.attemptId,
        evidenceHash: input.expectedEvidenceHash,
        answer,
      });
    await render();
    expect(
      container.querySelector(".activity-body .answer-value")?.textContent,
    ).toBe(answer === null ? "NULL" : String(answer));
    expect(container.textContent).not.toContain("Loading saved answer");
  },
);

it("does not read an unsealed completed body through either answer or raw disclosures", async () => {
  const unsealed = view();
  unsealed.attempts[0]!.evidenceHash = undefined;
  await render(unsealed);
  expect(container.textContent).toContain("no sealed evidence identity");
  expect(requested("runs.answer")).toHaveLength(0);
  expect(requested("runs.attempt")).toHaveLength(0);
  await tab("Attempts");
  await disclosure("Recorded attempt data");
  expect(requested("runs.attempt")).toHaveLength(0);
});

it.each([true, false])(
  "cancels late compact success=%s when human-review disclosure closes",
  async (success) => {
    const normal = respond;
    let complete!: (response: Response) => void;
    respond = (operation, input) =>
      operation === "runs.answer"
        ? new Promise<Response>((resolve) => {
            complete = resolve;
          })
        : normal(operation, input);
    await act(async () =>
      root.render(
        <ReviewDialog
          view={view()}
          pass={pass()}
          resultId="r1"
          onClose={() => {}}
          onSaved={() => {}}
        />,
      ),
    );
    await disclosure("Recorded answer and reference");
    const pending = requested("runs.answer")[0]!;
    await disclosure("Recorded answer and reference", false);
    expect(pending.signal.aborted).toBe(true);
    await act(async () =>
      complete(
        success
          ? Response.json({
              attemptId: "a1",
              evidenceHash: "hash-a1",
              answer: "STALE REVIEW ANSWER",
            })
          : Response.json(
              { error: { message: "STALE REVIEW ERROR" } },
              { status: 503 },
            ),
      ),
    );
    expect(document.body.textContent).not.toContain("STALE REVIEW");
    expect(document.body.textContent).not.toContain("Loading saved answer");
  },
);

it("does not substitute a current answer into an old no-answer score and permits explicit history inspection", async () => {
  const old = pass("old", "");
  await render(view(), "r1", old);
  expect(requested("runs.answer")).toHaveLength(0);
  expect(container.textContent).toContain("This score has no assessed answer");
  await tab("Attempts");
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>(
      '[aria-label="Recorded attempt"]',
    )!;
    select.value = "older";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await tab("Answer");
  expect(requested("runs.answer").at(-1)?.input.attemptId).toBe("older");
  expect(container.textContent).toContain("ANSWER-older");
});

it("reads human-review answers only while disclosed, pins their hash, and preserves draft edits across questions", async () => {
  await act(async () =>
    root.render(
      <ReviewDialog
        view={view()}
        pass={pass()}
        resultId="r1"
        onClose={() => {}}
        onSaved={() => {}}
      />,
    ),
  );
  expect(requested("runs.answer")).toHaveLength(0);
  expect(requested("runs.attempt")).toHaveLength(0);
  await disclosure("Recorded answer and reference");
  expect(requested("runs.answer")[0]?.input).toEqual({
    runId: "logical",
    attemptId: "a1",
    expectedEvidenceHash: "hash-a1",
  });
  expect(document.body.textContent).toContain("ANSWER-a1");
  const name = document.querySelector<HTMLInputElement>(
    '[aria-label="Review name"]',
  )!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(name, "Keep my draft");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const reviewer = document.querySelector<HTMLInputElement>(
    '[aria-label="Reviewer"]',
  )!;
  const note = document.querySelector<HTMLTextAreaElement>(
    '[aria-label="Reason or review note"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!.call(reviewer, "Draft reviewer");
    reviewer.dispatchEvent(new Event("input", { bubbles: true }));
    Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(note, "Preserved first-question note");
    note.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    const select = document.querySelector<HTMLSelectElement>(
      '[aria-label="Review question"]',
    )!;
    select.value = "r2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(document.body.textContent).not.toContain("ANSWER-a1");
  expect(
    document.querySelector<HTMLInputElement>('[aria-label="Review name"]')!
      .value,
  ).toBe("Keep my draft");
  expect(requested("runs.answer")).toHaveLength(1);
  expect(
    document.querySelector<HTMLInputElement>('[aria-label="Reviewer"]')!.value,
  ).toBe("Draft reviewer");
  await act(async () => {
    const select = document.querySelector<HTMLSelectElement>(
      '[aria-label="Review question"]',
    )!;
    select.value = "r1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(
    document.querySelector<HTMLTextAreaElement>(
      '[aria-label="Reason or review note"]',
    )!.value,
  ).toBe("Preserved first-question note");
  expect(document.body.textContent).toContain("1 question reviewed");
  expect(requested("runs.answer")).toHaveLength(1);
});
