// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  AssessmentPassDetail,
  JevAssessmentRecord,
  JevAssessmentSummary,
  RunView,
} from "../contracts.js";
import { Observe } from "./observe.js";
import { JevAssessment } from "./jev-assessment.js";

const reviewedName =
  "Human review with a deliberately long descriptive name for saved answer corrections";
function pass(id: string, correct: number): AssessmentPassDetail {
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
  events: [],
  cursor: 0,
} as unknown as RunView;

let root: Root, container: HTMLDivElement, view: RunView;
const request = vi.fn();
let assessmentResponse: (id: string, revision?: string) => Promise<Response>;
let selectionResponse: (id: string) => Promise<Response>;
let jevResponse: (input: Record<string, unknown>) => Promise<Response>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  view = structuredClone(baseView);
  assessmentResponse = async (id) =>
    Response.json(passes.find((item) => item.id === id));
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
      return assessmentResponse(
        input.passId,
        input.expectedObservationRevision,
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
  const pendingPass: AssessmentPassDetail = {
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
  const original: AssessmentPassDetail = {
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
function resumeAndHalt(original: AssessmentPassDetail): AssessmentPassDetail {
  const advanced: AssessmentPassDetail = {
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
function observingJev(): AssessmentPassDetail {
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
