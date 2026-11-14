// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  AssessmentPass,
  JevAssessmentRecord,
  JevAssessmentSummary,
  RunView,
} from "../contracts.js";
import { Observe } from "./observe.js";
import { JevAssessment } from "./jev-assessment.js";
type FixturePass = AssessmentPass & { observationRevision: string };

const reviewedName =
  "Human review with a deliberately long descriptive name for saved answer corrections";
function pass(id: string, correct: number): FixturePass {
  return {
    id,
    observationRevision: `revision-${id}`,
    runId: "run",
    name: id === "human" ? reviewedName : `Saved ${id}`,
    source: id === "human" ? "human" : "deterministic",
    status: "completed",
    createdAt: "2026-10-05T12:00:00Z",
    basis: {
      bankRevisionId: "bank",
      evaluatorRevisionId: "eval",
      referenceHash: "hash",
      eligibleResultIds: ["result"],
      excludedResultIds: [],
    },
    configuration: {},
    judgments: [
      {
        resultId: "result",
        status: correct ? "correct" : "incorrect",
        explanation: correct
          ? "Accepted by human review."
          : "Reference differs.",
      },
    ],
    coverage: {
      eligible: 5,
      answered: 5,
      judged: 3,
      correct,
      incorrect: 3 - correct,
      unjudged: 2,
      errors: 1,
      excluded: 1,
      reviewed: 0,
      overridden: 0,
    },
    accuracy: correct / 3,
    judgedAccuracy: correct / 3,
  };
}
const passes = [
  pass("rules", 0),
  pass("llm", 1),
  pass("jev", 1),
  pass("human", 2),
];
const baseView = {
  run: {
    id: "run",
    name: "Saved evaluation",
    status: "completed",
    createdAt: "2026-10-05T12:00:00Z",
    manifest: {
      bank: {
        id: "bank",
        bankId: "bank",
        name: "Bank",
        number: 1,
        questions: [{ id: "q1", text: "Total revenue?", expected: 42 }],
      },
      evaluator: { id: "eval", number: 1, name: "Exact", settings: {} },
      target: { kind: "external", adapterId: "generic-http", name: "Fixture" },
      repetitions: 1,
      questions: [{ id: "q1", text: "Total revenue?", expected: 42 }],
      judge: { enabled: false },
    },
  },
  results: [
    { id: "result", questionId: "q1", repetition: 1, status: "completed" },
  ],
  attempts: [],
  assessmentPasses: passes,
  selectedAssessmentPassId: "human",
  progress: { completed: 1, total: 1, failed: 0 },
  allowedActions: [],
  jevAssessments: [],
  reviews: [],
} as unknown as RunView;

let root: Root, container: HTMLDivElement, view: RunView;
const request = vi.fn();
let assessmentResponse: (id: string, revision?: string) => Promise<Response>;
let selectionResponse: (id: string) => Promise<Response>;
let jevResponse: (input: Record<string, unknown>) => Promise<Response>;
let exportResponse: (
  id: string,
  revision?: string,
  signal?: AbortSignal,
) => Promise<Response>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  view = structuredClone(baseView);
  assessmentResponse = async (id) =>
    Response.json(passes.find((item) => item.id === id));
  exportResponse = (id, revision) => assessmentResponse(id, revision);
  selectionResponse = async (id) => {
    view.selectedAssessmentPassId = id;
    return Response.json({ selectedAssessmentPassId: id });
  };
  jevResponse = async () => {
    throw new Error("Unexpected Jev inspection");
  };
  request.mockReset();
  request.mockImplementation(async (url: string, options: RequestInit) => {
    const input = JSON.parse(options.body as string);
    if (url.endsWith("/runs.get") || url.endsWith("/runs.observe"))
      return Response.json(view);
    if (url.endsWith("/runs.assessment"))
      return assessmentResponse(
        input.passId,
        input.expectedObservationRevision,
      );
    if (url.endsWith("/runs.select-assessment"))
      return selectionResponse(input.passId);
    if (url.endsWith("/runs.answer"))
      return Response.json({
        attemptId: input.attemptId,
        evidenceHash: input.expectedEvidenceHash,
        answer: input.attemptId === "a3" ? 41 : 42,
      });
    if (url.endsWith("/runs.attempt"))
      return Response.json({
        attempt: {
          ...view.attempts.find((attempt) => attempt.id === input.attemptId),
          output: {
            answer: input.attemptId === "a3" ? 41 : 42,
            text: input.attemptId === "a3" ? "41" : "42",
          },
        },
        events: [],
      });
    if (url.endsWith("/runs.attempt-events"))
      return Response.json({ events: [], cursor: 0 });
    if (url.endsWith("/runs.export-assessment"))
      return exportResponse(
        input.passId,
        input.expectedObservationRevision,
        options.signal ?? undefined,
      );
    if (url.endsWith("/runs.review-assessment"))
      return Response.json(
        {
          error: {
            code: "conflict",
            message: "Review basis changed. Your edits remain available.",
          },
        },
        { status: 409 },
      );
    if (url.endsWith("/jev.get")) return jevResponse(input);
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const render = async (initialAssessmentId?: string, initialResultId?: string) =>
  act(async () => {
    root.render(
      <Observe
        runId="run"
        initialAssessmentId={initialAssessmentId}
        initialResultId={initialResultId}
        refreshWorkspace={() => {}}
      />,
    );
  });
const selector = () =>
  container.querySelector<HTMLSelectElement>('[aria-label="Saved score"]')!;
const summary = () =>
  container.querySelector<HTMLElement>('[aria-label="Selected saved score"]')!;
const grading = () => container.querySelector(".grading-body")!.textContent;
const select = async (id: string) =>
  act(async () => {
    selector().value = id;
    selector().dispatchEvent(new Event("change", { bubbles: true }));
  });
const click = async (text: string) =>
  act(async () => {
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === text)!
      .click();
  });

it.each([0, 1])(
  "keeps score identity and coverage without a dead chooser for %i saved scores",
  async (count) => {
    view.assessmentPasses = passes.slice(0, count);
    view.selectedAssessmentPassId = count ? "rules" : undefined;
    await render();
    expect(selector()).toBeNull();
    expect(summary().querySelector("h2")?.textContent).toBe(
      count ? "Saved rules" : "Assessment pending",
    );
    expect(summary().textContent?.split("Saved rules")).toHaveLength(
      count ? 2 : 1,
    );
    expect(summary().textContent).toContain(
      count ? "3 / 5 judged" : "Awaiting results",
    );
    expect(
      request.mock.calls.filter(([url]) =>
        url.endsWith("/runs.select-assessment"),
      ),
    ).toHaveLength(0);
  },
);

it("summarizes only the selected fourth pass with its full name and judgments", async () => {
  await render();
  expect(selector().value).toBe("human");
  expect(selector().options).toHaveLength(4);
  expect(summary()).not.toBeNull();
  expect(summary().querySelectorAll(".assessment-score")).toHaveLength(1);
  expect(summary().querySelector("h2")?.textContent).toBe(reviewedName);
  expect(
    summary().querySelector(".selected-score-source")?.textContent,
  ).toContain("Human review");
  expect(summary().textContent).toContain("66.7%");
  expect(summary().textContent).toContain("2 / 3 correct");
  expect(summary().textContent).toContain("3 / 5 judged");
  expect(summary().textContent).toContain("2 unjudged");
  expect(summary().textContent).toContain("1 assessment errors");
  expect(summary().textContent).toContain("1 excluded");
  expect(
    container.querySelector('[aria-label="All assessment scores"]'),
  ).toBeNull();
  expect(grading()).toContain("Accepted by human review.");
  expect(grading()).not.toContain("Reference differs.");
});

it("keeps selection, summary, question judgments, and Summary together while details load out of order", async () => {
  const delayed = new Map<string, (response: Response) => void>();
  assessmentResponse = (id) =>
    new Promise((resolve) => {
      delayed.set(id, resolve);
    });
  await render();
  await select("rules");
  expect(selector().value).toBe("rules");
  expect(summary().textContent).toContain("0.0%");
  expect(summary().textContent).not.toContain("66.7%");
  expect(grading()).toContain("Reference differs.");
  expect(grading()).not.toContain("Accepted by human review.");
  await act(async () => delayed.get("human")!(Response.json(passes[3])));
  expect(selector().value).toBe("rules");
  expect(grading()).toContain("Reference differs.");
  await act(async () => delayed.get("rules")!(Response.json(passes[0])));
  await click("Summary");
  expect(container.querySelector(".score-overview")?.textContent).toContain(
    "0.0%",
  );
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(selector().value).toBe("rules");
  expect(summary().textContent).toContain("0.0%");
});

it("keeps the previous selection and judgments when saving another selection fails", async () => {
  selectionResponse = async () =>
    Response.json(
      { error: { message: "Selection could not be saved." } },
      { status: 500 },
    );
  await render();
  await select("rules");
  expect(selector().value).toBe("human");
  expect(summary().textContent).toContain("66.7%");
  expect(grading()).toContain("Accepted by human review.");
  expect(container.textContent).toContain("Selection could not be saved.");
  expect(request.mock.calls.map(([url]) => url)).toEqual([
    "/api/commands/runs.get",
    "/api/commands/runs.assessment",
    "/api/commands/runs.select-assessment",
  ]);
});

it("keeps the newly selected score and judgments when its detail query fails", async () => {
  await render();
  assessmentResponse = async () =>
    Response.json(
      { error: { message: "Saved detail unavailable." } },
      { status: 500 },
    );
  await select("rules");
  expect(selector().value).toBe("rules");
  expect(summary().textContent).toContain("0.0%");
  expect(grading()).toContain("Reference differs.");
  expect(grading()).not.toContain("Accepted by human review.");
  expect(container.textContent).toContain("Saved detail unavailable.");
});

it("honors a linked saved pass and displays interrupted and running status without a zero score", async () => {
  const pendingPass: FixturePass = {
    ...passes[3]!,
    status: "interrupted",
    judgedAccuracy: null,
    accuracy: null,
    judgments: [],
    coverage: { ...passes[3]!.coverage, correct: 0, judged: 0 },
  };
  view.assessmentPasses = [...passes.slice(0, 3), pendingPass];
  view.selectedAssessmentPassId = "rules";
  assessmentResponse = async () => Response.json(pendingPass);
  await render("human");
  expect(selector().value).toBe("human");
  expect(
    summary()
      .querySelector(".selected-score-source")
      ?.textContent?.toLowerCase(),
  ).toContain("interrupted");
  expect(summary().textContent).toContain("Awaiting results");
  expect(summary().textContent).not.toContain("0.0%");
  await act(async () => root.unmount());
  root = createRoot(container);
  view.assessmentPasses = [{ ...pendingPass, status: "running" }];
  await render();
  expect(
    summary()
      .querySelector(".selected-score-source")
      ?.textContent?.toLowerCase(),
  ).toContain("running");
  expect(summary().textContent).not.toContain("0.0%");
  expect(
    Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Review judgments",
    )?.disabled,
  ).toBe(true);
  expect(
    Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Review this question",
    )?.disabled,
  ).toBe(true);
});

it("shows a pending assessment without selection and disables review before any passes exist", async () => {
  view.assessmentPasses = [];
  view.progress.completed = 0;
  await render();
  expect(selector()).toBeNull();
  expect(summary().textContent).toContain("Assessment pending");
  expect(summary().textContent).toContain("Awaiting results");
  expect(summary().textContent).not.toContain("0.0%");
  expect(
    Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Review judgments",
    )?.disabled,
  ).toBe(true);
  expect(request.mock.calls).toHaveLength(1);
});

function interruptedRun() {
  view.run.status = "halted";
  view.run.manifest.questions.push({
    id: "q2",
    text: "Second question?",
    expected: 42,
    tags: [],
  });
  view.run.manifest.bank.questions = view.run.manifest.questions;
  view.results = [
    {
      id: "result",
      runId: "run",
      questionId: "q1",
      repetition: 1,
      status: "completed",
      completedAttemptId: "a1",
      attemptIds: ["a1"],
    },
    {
      id: "second",
      runId: "run",
      questionId: "q2",
      repetition: 1,
      status: "interrupted",
      attemptIds: ["a2"],
    },
  ];
  view.attempts = [
    {
      id: "a1",
      runId: "run",
      resultId: "result",
      number: 1,
      status: "completed",
      hasOutput: true,
      evidenceHash: "sealed-a1",
      startedAt: "2026-10-05T12:00:00Z",
    },
    {
      id: "a2",
      runId: "run",
      resultId: "second",
      number: 1,
      status: "interrupted",
      hasOutput: false,
      startedAt: "2026-10-05T12:00:00Z",
    },
  ];
  view.progress = { completed: 1, total: 2, failed: 1 };
  const original: FixturePass = {
    ...passes[0]!,
    id: "original_deterministic_run",
    name: "Original deterministic",
    status: "interrupted",
    observationRevision: "before-resume",
    basis: {
      ...passes[0]!.basis,
      eligibleResultIds: ["result", "second"],
      excludedResultIds: [],
    },
    judgments: [
      {
        resultId: "result",
        attemptId: "a1",
        status: "correct",
        explanation: "First answer matches.",
      },
      {
        resultId: "second",
        status: "unjudged",
        explanation: "No completed answer.",
      },
    ],
    coverage: {
      eligible: 2,
      answered: 1,
      judged: 1,
      correct: 1,
      incorrect: 0,
      unjudged: 1,
      errors: 0,
      excluded: 0,
      reviewed: 0,
      overridden: 0,
    },
    accuracy: 1,
    judgedAccuracy: 1,
  };
  view.assessmentPasses = [original];
  view.selectedAssessmentPassId = original.id;
  return original;
}
function resumeAndHalt(original: FixturePass): FixturePass {
  const advanced: FixturePass = {
    ...original,
    observationRevision: "after-resume",
    judgments: [
      original.judgments[0]!,
      {
        resultId: "second",
        attemptId: "a3",
        status: "incorrect",
        explanation: "Second answer differs.",
      },
    ],
    coverage: {
      ...original.coverage,
      answered: 2,
      judged: 2,
      incorrect: 1,
      unjudged: 0,
    },
    accuracy: 0.5,
    judgedAccuracy: 0.5,
  };
  view.assessmentPasses = [advanced];
  view.results[1] = {
    ...view.results[1]!,
    status: "completed",
    completedAttemptId: "a3",
    attemptIds: ["a2", "a3"],
  };
  view.attempts.push({
    id: "a3",
    runId: "run",
    resultId: "second",
    number: 2,
    status: "completed",
    hasOutput: true,
    evidenceHash: "sealed-a3",
    startedAt: "2026-10-05T12:00:02Z",
  });
  view.progress = { completed: 2, total: 2, failed: 0 };
  return advanced;
}

it("uses fresh same-status observations and matching detail while a late old-revision response arrives", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const original = interruptedRun();
  let finishOld!: (response: Response) => void;
  const oldResponse = new Promise<Response>((resolve) => {
    finishOld = resolve;
  });
  let advanced = original;
  assessmentResponse = async (_id, revision) =>
    revision === original.observationRevision
      ? oldResponse
      : Response.json(advanced);
  await render(undefined, "second");
  advanced = resumeAndHalt(original);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(summary().textContent).toContain("50.0%");
  expect(grading()).toContain("Second answer differs.");
  await act(async () => finishOld(Response.json(original)));
  expect(summary().textContent).toContain("50.0%");
  expect(grading()).toContain("Second answer differs.");
  expect(grading()).not.toContain("No completed answer.");
  expect(
    request.mock.calls
      .filter(([url]) => url.endsWith("/runs.assessment"))
      .map(
        ([, options]) =>
          JSON.parse(options.body as string).expectedObservationRevision,
      ),
  ).toEqual(["before-resume", "after-resume"]);
});

it("retains the review snapshot and unsaved edits when its parent advances and rejects the old review", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const original = interruptedRun();
  assessmentResponse = async () => Response.json(original);
  await render();
  await click("Review judgments");
  const note = document.querySelector<HTMLTextAreaElement>(
    '[aria-label="Reason or review note"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(note, "Keep my original review note.");
    note.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const advanced = resumeAndHalt(original);
  assessmentResponse = async () => Response.json(advanced);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(summary().textContent).toContain("50.0%");
  expect(document.querySelector(".review-basis")?.textContent).toContain(
    "100.0%",
  );
  expect(note.value).toBe("Keep my original review note.");
  await act(async () =>
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Save reviewed score")!
      .click(),
  );
  const call = request.mock.calls.find(([url]) =>
    url.endsWith("/runs.review-assessment"),
  )!;
  expect(JSON.parse(call[1].body as string)).toMatchObject({
    parentPassId: original.id,
    expectedObservationRevision: "before-resume",
    overrides: [{ note: "Keep my original review note." }],
  });
  expect(document.body.textContent).toContain(
    "Close this review and reopen it from the current score.",
  );
  expect(document.body.textContent).toContain(
    "Your unsaved edits remain until you close this review.",
  );
  expect(
    document
      .querySelector('[role="dialog"]')!
      .querySelectorAll('[role="alert"]'),
  ).toHaveLength(1);
  expect(
    Array.from(
      document.querySelector('[role="dialog"]')!.querySelectorAll("button"),
    ).find((button) => button.textContent === "Retry loading"),
  ).toBeUndefined();
  expect(note.value).toBe("Keep my original review note.");
  expect(
    Array.from(
      document.querySelector('[role="dialog"]')!.querySelectorAll("button"),
    ).find((button) => button.textContent === "Save reviewed score")?.disabled,
  ).toBe(true);
});

it("retries transient review detail loading for the captured revision without clearing edits", async () => {
  const original = interruptedRun();
  assessmentResponse = async () => Response.json(original);
  await render();
  assessmentResponse = async () =>
    Response.json(
      {
        error: {
          code: "unavailable",
          message: "Saved detail temporarily unavailable.",
        },
      },
      { status: 503 },
    );
  await click("Review judgments");
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Saved detail temporarily unavailable.");
  const note = dialog.querySelector<HTMLTextAreaElement>(
    '[aria-label="Reason or review note"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(note, "Keep my draft while loading.");
    note.dispatchEvent(new Event("input", { bubbles: true }));
  });
  let finish!: (response: Response) => void;
  assessmentResponse = () =>
    new Promise<Response>((resolve) => {
      finish = resolve;
    });
  const retry = Array.from(dialog.querySelectorAll("button")).find(
    (button) => button.textContent === "Retry loading",
  );
  expect(retry).toBeDefined();
  await act(async () => retry!.click());
  expect(note.value).toBe("Keep my draft while loading.");
  await act(async () => finish(Response.json(original)));
  expect(note.value).toBe("Keep my draft while loading.");
  expect(dialog.querySelector('[role="alert"]')).toBeNull();
  expect(
    Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent === "Save reviewed score",
    )?.disabled,
  ).toBe(false);
  expect(
    request.mock.calls
      .filter(([url]) => url.endsWith("/runs.assessment"))
      .map(
        ([, options]) =>
          JSON.parse(options.body as string).expectedObservationRevision,
      ),
  ).toEqual(["before-resume", "before-resume", "before-resume"]);
});

it("reads corrected references and keeps an exported pass filename when selection changes", async () => {
  const historical = {
    ...passes[3]!,
    basis: { ...passes[3]!.basis, bankRevisionId: "corrected-bank" },
    configuration: {
      referenceBank: {
        ...view.run.manifest.bank,
        id: "corrected-bank",
        questions: [
          { id: "q1", text: "Total revenue?", expected: 84, tags: [] },
        ],
      },
    },
  };
  view.assessmentPasses![3] = historical;
  assessmentResponse = async (id) =>
    Response.json(id === "human" ? historical : passes[0]);
  await render();
  expect(grading()).toContain("84");
  await click("Summary");
  await click("Export score");
  await select("rules");
  const filenames: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    filenames.push(this.download);
  });
  vi.stubGlobal("URL", {
    createObjectURL: () => "blob:fixture",
    revokeObjectURL: () => {},
  });
  await act(async () =>
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Download score JSON")!
      .click(),
  );
  expect(filenames).toEqual(["run-human.json"]);
  const call = request.mock.calls.find(([url]) =>
    url.endsWith("/runs.export-assessment"),
  )!;
  expect(JSON.parse(call[1].body as string)).toMatchObject({
    passId: "human",
    expectedObservationRevision: historical.observationRevision,
  });
});

const pendingJev: JevAssessmentSummary = {
  id: "J",
  runId: "run",
  resultId: "result",
  attemptId: "a1",
  createdAt: "2026-10-05T12:00:00Z",
  kind: "original",
  status: "pending",
  published: true,
  profileRevisionId: "profile",
  profileRevisionNumber: 1,
  profileName: "Observed Jev",
  confidenceThreshold: 0.7,
};
const fullJev = {
  ...pendingJev,
  status: "completed",
  configuration: { profile: { name: "Observed Jev", number: 1 } },
  evidenceHash: "jev-evidence",
  attemptEvidenceHash: "sealed-a1",
  evidence: { marker: "FULL_EVIDENCE" },
  criteria: { marker: "ORIGINAL_CRITERIA" },
  request: { marker: "PRIMARY_REQUEST" },
  response: { marker: "PRIMARY_RESPONSE" },
  attempts: { marker: "ALL_ATTEMPTS" },
  fallback: {
    trigger: { error: { code: "size", message: "ORIGINAL_SIZE_ERROR" } },
    criteria: { marker: "FALLBACK_CRITERIA" },
  },
} as unknown as JevAssessmentRecord;
function observingJev(): FixturePass {
  const original = interruptedRun();
  const pass = {
    ...original,
    id: "original_jev_run",
    source: "jev" as const,
    status: "running" as const,
    observationRevision: "pending-jev",
    judgments: [
      {
        ...original.judgments[0]!,
        jevAssessmentId: "J",
        jevAssessmentStatus: "pending" as const,
        status: "unjudged" as const,
        explanation: "Jev pending.",
      },
      original.judgments[1]!,
    ],
    coverage: { ...original.coverage, judged: 0, correct: 0, unjudged: 2 },
    accuracy: null,
    judgedAccuracy: null,
  };
  view.run.status = "running";
  view.assessmentPasses = [pass];
  view.selectedAssessmentPassId = pass.id;
  view.jevAssessments = [pendingJev];
  return pass;
}

function capturedScores() {
  const original = observingJev();
  const scores = ["A", "B"].map((id) => ({
    ...original,
    id,
    name: `Captured score ${id}`,
    status: "interrupted" as const,
    observationRevision: `revision-${id}`,
  }));
  view.run.status = "completed";
  view.assessmentPasses = scores;
  view.selectedAssessmentPassId = "A";
  view.jevAssessments = [{ ...pendingJev, status: "completed" }];
  assessmentResponse = async (id) => {
    const selected = scores.find((score) => score.id === id)!;
    return Response.json({
      configuration: selected.configuration,
      judgments: selected.judgments,
      observationRevision: selected.observationRevision,
    });
  };
  return scores;
}

it.each([false, true])(
  "keeps the latest explicit captured-score inspection after superseded failure=%s",
  async (failure) => {
    const scores = capturedScores();
    const deferred = new Map<
      string,
      { resolve: (response: Response) => void; signal?: AbortSignal }
    >();
    exportResponse = (id, _revision, signal) =>
      new Promise((resolve) => deferred.set(id, { resolve, signal }));
    await render("A", "result");
    await click("Inspect captured score");
    await select("B");
    expect(deferred.get("A")!.signal?.aborted).not.toBe(true);
    await click("Inspect captured score");
    await act(async () => deferred.get("B")!.resolve(Response.json(scores[1])));
    expect(
      JSON.parse(document.querySelector("dialog pre")!.textContent!).id,
    ).toBe("B");
    await act(async () =>
      deferred.get("A")!.resolve(
        failure
          ? Response.json(
              {
                error: {
                  code: "late_failure",
                  message: "SUPERSEDED_INSPECTION_FAILURE",
                },
              },
              { status: 500 },
            )
          : Response.json(scores[0]),
      ),
    );
    expect(
      JSON.parse(document.querySelector("dialog pre")!.textContent!).id,
    ).toBe("B");
    expect(document.body.textContent).not.toContain(
      "SUPERSEDED_INSPECTION_FAILURE",
    );
    expect(document.querySelector("dialog p")?.textContent).toBe(
      "Captured score B",
    );
    expect(deferred.get("A")!.signal?.aborted).toBe(true);
    expect(deferred.get("B")!.signal?.aborted).toBe(false);
    expect(summary().querySelector("h2")?.textContent).toBe("Captured score B");
    let download: Blob | undefined;
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation((blob) => {
        if (!(blob instanceof Blob))
          throw new Error("Expected downloadable score JSON");
        download = blob;
        return "blob:inspection-fixture";
      });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const anchor = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        expect(this.download).toBe("run-B.json");
      });
    await act(async () =>
      Array.from(document.querySelectorAll("dialog button"))
        .find((button) => button.textContent?.trim() === "Download score JSON")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(anchor).toHaveBeenCalledOnce();
    expect(JSON.parse(await download!.text()).id).toBe("B");
  },
);

it("cancels captured-score inspection on unmount even when its transport ignores abort", async () => {
  const scores = capturedScores();
  let release!: (response: Response) => void, signal: AbortSignal | undefined;
  exportResponse = (_id, _revision, active) => {
    signal = active;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  await render("A", "result");
  await click("Inspect captured score");
  await act(async () => root.unmount());
  root = createRoot(container);
  expect(signal?.aborted).toBe(true);
  await act(async () => release(Response.json(scores[0])));
  expect(document.querySelector("dialog")).toBeNull();
});

it("fulfills a named earlier inspection after selection alone and clears action errors on the next request", async () => {
  const scores = capturedScores();
  let release!: (response: Response) => void;
  exportResponse = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  await render("A", "result");
  await click("Inspect captured score");
  await select("B");
  await act(async () =>
    release(
      Response.json(
        { error: { code: "unavailable", message: "FIRST_INSPECTION_ERROR" } },
        { status: 503 },
      ),
    ),
  );
  expect(document.body.textContent).toContain("FIRST_INSPECTION_ERROR");
  await select("A");
  await click("Inspect captured score");
  await select("B");
  expect(document.body.textContent).not.toContain("FIRST_INSPECTION_ERROR");
  await act(async () => release(Response.json(scores[0])));
  expect(
    JSON.parse(document.querySelector("dialog pre")!.textContent!).id,
  ).toBe("A");
  expect(document.querySelector("dialog p")?.textContent).toBe(
    "Captured score A",
  );
  expect(summary().querySelector("h2")?.textContent).toBe("Captured score B");
});

it.each([false, true])(
  "opens only the captured score on explicit inspection after Jev settles, with stale=%s",
  async (stale) => {
    const captured = observingJev();
    captured.id = "finding-snapshot";
    captured.status = "interrupted";
    captured.source = "human";
    captured.judgments[0]!.request = { marker: "CAPTURED_PENDING_REQUEST" };
    view.run.status = "completed";
    view.assessmentPasses = [captured];
    view.selectedAssessmentPassId = captured.id;
    view.jevAssessments = [{ ...pendingJev, status: "completed" }];
    assessmentResponse = async () =>
      Response.json({
        configuration: captured.configuration,
        observationRevision: captured.observationRevision,
        judgments: captured.judgments.map(
          ({ request: _request, response: _response, ...judgment }) => judgment,
        ),
      });
    exportResponse = async () =>
      stale
        ? Response.json(
            {
              error: {
                code: "conflict",
                message: "The captured score changed.",
              },
            },
            { status: 409 },
          )
        : Response.json(captured);
    await render(captured.id, "result");
    expect(container.textContent).toContain(
      "This score retains its captured Jev state",
    );
    expect(document.body.textContent).not.toContain("CAPTURED_PENDING_REQUEST");
    expect(
      request.mock.calls.some(([url]) =>
        url.endsWith("/runs.export-assessment"),
      ),
    ).toBe(false);
    expect(
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent === "Inspect captured score",
      ),
    ).toBe(true);
    await click("Inspect captured score");
    const exportCall = request.mock.calls.find(([url]) =>
      url.endsWith("/runs.export-assessment"),
    )!;
    expect(JSON.parse(exportCall[1].body as string)).toEqual({
      runId: "run",
      passId: captured.id,
      expectedObservationRevision: captured.observationRevision,
    });
    if (stale) {
      expect(document.body.textContent).toContain(
        "The captured score changed.",
      );
      expect(document.body.textContent).not.toContain(
        "CAPTURED_PENDING_REQUEST",
      );
    } else {
      expect(document.body.textContent).toContain("Export saved score");
      expect(document.body.textContent).toContain("CAPTURED_PENDING_REQUEST");
      expect(document.body.textContent).toContain(
        '"jevAssessmentStatus": "pending"',
      );
    }
    expect(document.body.textContent).not.toContain("PRIMARY_RESPONSE");
    expect(request.mock.calls.some(([url]) => url.endsWith("/jev.get"))).toBe(
      false,
    );
    expect(summary().querySelector("h2")?.textContent).toBe(captured.name);
    expect(
      container.querySelector('[aria-label="Selected question"] h2')
        ?.textContent,
    ).toBe("Total revenue?");
  },
);

it.each([true, false])(
  "uses one raw provenance entry point for Jev-bound judgments: %s",
  async (jevBound) => {
    const selected = observingJev();
    selected.status = "completed";
    view.run.status = "completed";
    view.jevAssessments = [{ ...pendingJev, status: "completed" }];
    const judgment = selected.judgments[0]!;
    judgment.jevAssessmentStatus = "completed";
    judgment.request = { marker: "INLINE_JEV_REQUEST" };
    judgment.response = { marker: "INLINE_JEV_RESPONSE" };
    if (!jevBound) {
      selected.source = "llm";
      delete judgment.jevAssessmentId;
      delete judgment.jevAssessmentStatus;
      judgment.request = { marker: "LLM_REQUEST" };
      judgment.response = { marker: "LLM_RESPONSE" };
      view.jevAssessments = [];
    }
    assessmentResponse = async () =>
      Response.json({
        configuration: selected.configuration,
        observationRevision: selected.observationRevision,
        judgments: selected.judgments.map(
          ({ request: _request, response: _response, ...item }) => ({
            ...item,
            hasRecordedExchange: !jevBound,
          }),
        ),
      });
    exportResponse = async () => Response.json(selected);
    jevResponse = async () => Response.json(fullJev);
    await render();
    if (!jevBound) {
      expect(container.textContent).toContain(
        "Assessment request and response",
      );
      expect(container.textContent).not.toContain("LLM_REQUEST");
      expect(container.textContent).not.toContain("LLM_RESPONSE");
      expect(container.querySelector(".jev-assessment")).toBeNull();
      return;
    }
    expect(container.textContent).not.toContain(
      "Assessment request and response",
    );
    expect(container.querySelectorAll(".jev-assessment button")).toHaveLength(
      1,
    );
    expect(
      request.mock.calls.filter(([url]) => url.endsWith("/jev.get")),
    ).toHaveLength(0);
    await click("Inspect recorded request and provenance");
    expect(document.body.textContent).toContain("PRIMARY_REQUEST");
    expect(document.body.textContent).toContain("PRIMARY_RESPONSE");
    expect(document.body.textContent).not.toContain("INLINE_JEV_REQUEST");
  },
);

it.each(["llm", "human"] as const)(
  "loads a complete %s exchange only when its inline disclosure opens",
  async (source) => {
    const selected = structuredClone(passes[1]!);
    selected.source = source;
    selected.judgments[0]!.request = { marker: "RAW_REQUEST_FIRST_LAST" };
    selected.judgments[0]!.response = { marker: "RAW_RESPONSE_FIRST_LAST" };
    selected.configuration.judge = { enabled: false, instructions: "Fixture" };
    view.selectedAssessmentPassId = selected.id;
    assessmentResponse = async () =>
      Response.json({
        configuration: selected.configuration,
        observationRevision: selected.observationRevision,
        judgments: [
          {
            resultId: "result",
            status: "correct",
            explanation: "Recorded",
            hasRecordedExchange: true,
          },
        ],
      });
    exportResponse = async () => Response.json(selected);
    await render();
    const exports = () =>
      request.mock.calls.filter(([url]) =>
        url.endsWith("/runs.export-assessment"),
      );
    expect(exports()).toHaveLength(0);
    expect(container.textContent).not.toContain("RAW_REQUEST_FIRST_LAST");
    const disclosure = Array.from(container.querySelectorAll("details")).find(
      (element) =>
        element.querySelector("summary")?.textContent ===
        "Assessment request and response",
    );
    expect(disclosure).toBeDefined();
    await act(async () => {
      disclosure!.open = true;
      disclosure!.dispatchEvent(new Event("toggle"));
    });
    expect(exports()).toHaveLength(1);
    expect(JSON.parse(exports()[0]![1].body as string)).toEqual({
      runId: "run",
      passId: selected.id,
      expectedObservationRevision: selected.observationRevision,
    });
    expect(container.textContent).toContain("RAW_REQUEST_FIRST_LAST");
    expect(container.textContent).toContain("RAW_RESPONSE_FIRST_LAST");
    expect(document.body.querySelector("dialog")).toBeNull();
  },
);

const rawDisclosure = () =>
  Array.from(container.querySelectorAll("details")).find(
    (element) =>
      element.querySelector("summary")?.textContent ===
      "Assessment request and response",
  )!;
const toggleRaw = async (open: boolean) =>
  act(async () => {
    const element = rawDisclosure();
    element.open = open;
    element.dispatchEvent(new Event("toggle"));
  });
function rawSelection() {
  const selected = structuredClone(passes[1]!);
  selected.source = "llm";
  selected.judgments[0]!.attemptId = "a1";
  selected.judgments[0]!.evidenceHash = "sealed";
  selected.judgments[0]!.request = { marker: "FULL_REQUEST_BEGIN_END" };
  selected.judgments[0]!.response = { marker: "FULL_RESPONSE_BEGIN_END" };
  view.assessmentPasses = [selected];
  view.selectedAssessmentPassId = selected.id;
  assessmentResponse = async () =>
    Response.json({
      configuration: selected.configuration,
      observationRevision: selected.observationRevision,
      judgments: selected.judgments.map(
        ({ request: _request, response: _response, ...item }) => ({
          ...item,
          hasRecordedExchange: true,
        }),
      ),
    });
  return selected;
}

it("shows exchange loading, stale errors and retry without exposing a mismatched physical answer", async () => {
  const selected = rawSelection();
  let release!: (response: Response) => void;
  exportResponse = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  await render();
  await toggleRaw(true);
  expect(container.textContent).toContain(
    "Loading recorded assessment exchange",
  );
  await act(async () =>
    release(
      Response.json(
        { error: { code: "conflict", message: "This saved score changed." } },
        { status: 409 },
      ),
    ),
  );
  expect(container.textContent).toContain("This saved score changed.");
  exportResponse = async () =>
    Response.json({
      ...selected,
      judgments: [{ ...selected.judgments[0], attemptId: "other-attempt" }],
    });
  await click("Retry loading assessment exchange");
  expect(container.textContent).toContain("does not match the selected score");
  expect(container.textContent).not.toContain("FULL_RESPONSE_BEGIN_END");
  exportResponse = async () => Response.json(selected);
  await click("Retry loading assessment exchange");
  expect(container.textContent).toContain("FULL_REQUEST_BEGIN_END");
  expect(container.textContent).toContain("FULL_RESPONSE_BEGIN_END");
});

it.each(["close", "selection", "unmount"] as const)(
  "cancels an exchange on %s and ignores transport completion after abort",
  async (change) => {
    const selected = rawSelection();
    const next = {
      ...selected,
      id: "second-score",
      observationRevision: "second-revision",
    };
    if (change === "selection") view.assessmentPasses!.push(next);
    const pending: Array<{
      release: (response: Response) => void;
      signal?: AbortSignal;
    }> = [];
    exportResponse = (_id, _revision, signal) =>
      new Promise((release) => pending.push({ release, signal }));
    await render();
    await toggleRaw(true);
    expect(pending).toHaveLength(1);
    if (change === "close") await toggleRaw(false);
    else if (change === "selection") {
      await select(next.id);
    } else await act(async () => root.render(null));
    expect(pending[0]!.signal?.aborted).toBe(true);
    await act(async () => pending[0]!.release(Response.json(selected)));
    expect(container.textContent).not.toContain("FULL_RESPONSE_BEGIN_END");
    if (change === "close") {
      await toggleRaw(true);
      expect(pending).toHaveLength(2);
      expect(container.textContent).not.toContain("FULL_REQUEST_BEGIN_END");
      await act(async () => pending[1]!.release(Response.json(selected)));
      expect(container.textContent).toContain("FULL_RESPONSE_BEGIN_END");
    }
  },
);

it("conditions Observe Jev provenance on the captured pass revision and rejects newer evidence", async () => {
  const pass = observingJev();
  jevResponse = async (input) =>
    input.assessmentContext
      ? Response.json(
          {
            error: { code: "conflict", message: "The observed score changed." },
          },
          { status: 409 },
        )
      : Response.json(fullJev);
  await render();
  await click("Inspect recorded request and provenance");
  const call = request.mock.calls.find(([url]) => url.endsWith("/jev.get"))!;
  expect(JSON.parse(call[1].body as string)).toEqual({
    assessmentId: "J",
    assessmentContext: {
      runId: "run",
      passId: pass.id,
      expectedObservationRevision: "pending-jev",
    },
  });
  expect(document.body.textContent).toContain("The observed score changed.");
  expect(document.body.textContent).not.toContain("PRIMARY_RESPONSE");
});

it.each([false, true])(
  "closes Jev inspection for changed assessments or settled historical pending records: %s",
  async (frozenPending) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pass = observingJev();
    if (frozenPending) {
      pass.id = "finding-snapshot";
      pass.status = "interrupted";
      view.assessmentPasses = [pass];
      view.selectedAssessmentPassId = pass.id;
      assessmentResponse = async () => Response.json(pass);
    }
    let finish!: (response: Response) => void;
    jevResponse = () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      });
    await render();
    await click("Inspect recorded request and provenance");
    if (!frozenPending)
      view.assessmentPasses = [
        {
          ...pass,
          observationRevision: "next-jev",
          judgments: [
            { ...pass.judgments[0]!, jevAssessmentId: "J2" },
            pass.judgments[1]!,
          ],
        },
      ];
    view.jevAssessments = [
      frozenPending
        ? { ...pendingJev, status: "completed" }
        : { ...pendingJev, id: "J2", profileName: "Second assessment" },
    ];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    await act(async () => finish(Response.json(fullJev)));
    expect(document.body.textContent).toContain(
      frozenPending
        ? "Use a current Jev score to inspect the settled assessment."
        : "Second assessment",
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).not.toContain("PRIMARY_RESPONSE");
  },
);

it("inspects a complete authoring-preview record directly with original and fallback provenance", async () => {
  await act(async () =>
    root.render(<JevAssessment assessment={fullJev} inspect />),
  );
  await click("Inspect recorded request and provenance");
  expect(request).not.toHaveBeenCalled();
  for (const text of [
    "FULL_EVIDENCE",
    "PRIMARY_REQUEST",
    "PRIMARY_RESPONSE",
    "ALL_ATTEMPTS",
    "ORIGINAL_SIZE_ERROR",
    "FALLBACK_CRITERIA",
  ])
    expect(document.body.textContent).toContain(text);
});

it("keeps historical no-answer judgments separate from explicitly browsed later answers", async () => {
  const original = interruptedRun();
  resumeAndHalt(original);
  const historical = {
    ...original,
    id: "historical-human",
    source: "human" as const,
    status: "completed" as const,
  };
  view.assessmentPasses = [historical];
  view.selectedAssessmentPassId = historical.id;
  assessmentResponse = async () => Response.json(historical);
  await render(undefined, "second");
  expect(grading()).toContain("No completed answer.");
  expect(container.querySelector(".activity-body")?.textContent).not.toContain(
    "41",
  );
  expect(
    request.mock.calls.filter(([url]) => url.endsWith("/runs.answer")),
  ).toHaveLength(0);
  await click("Attempts");
  await act(async () => {
    const attempts = container.querySelector<HTMLSelectElement>(
      '[aria-label="Recorded attempt"]',
    )!;
    attempts.value = "a3";
    attempts.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("Answer");
  expect(container.querySelector(".activity-body")?.textContent).toContain(
    "41",
  );
  expect(
    request.mock.calls
      .filter(([url]) => url.endsWith("/runs.answer"))
      .map(([, options]) => JSON.parse(options.body as string)),
  ).toEqual([
    { runId: "run", attemptId: "a3", expectedEvidenceHash: "sealed-a3" },
  ]);
  expect(container.querySelector(".activity-body")?.textContent).toContain(
    "This score has no assessed answer for this question. Showing another recorded attempt.",
  );
  expect(grading()).toContain("No completed answer.");
  await click("Review this question");
  expect(
    document.querySelector<HTMLOptionElement>('option[value="correct"]')
      ?.disabled,
  ).toBe(true);
  expect(
    document.querySelector<HTMLOptionElement>('option[value="incorrect"]')
      ?.disabled,
  ).toBe(true);
});
