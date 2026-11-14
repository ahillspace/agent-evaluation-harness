// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AssessmentPass, RunView } from "../contracts.js";
import { RunQuestions } from "./observation-questions.js";
import { ReviewDialog } from "./human-review.js";
type FixturePass = AssessmentPass & { observationRevision: string };

const { resource } = vi.hoisted(() => ({ resource: vi.fn() }));
vi.mock("./api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api.js")>()),
  command: vi.fn(),
  useResource: resource,
}));
const view = {
  run: {
    id: "original",
    status: "completed",
    manifest: {
      bank: {
        id: "bank",
        questions: [{ id: "q1", text: "Six times seven?", expected: 42 }],
      },
      evaluator: { id: "eval", name: "Answer rules", number: 1, settings: {} },
      questions: [{ id: "q1", text: "Six times seven?", expected: 42 }],
      target: { kind: "managed", agent: {} },
    },
  },
  results: [
    {
      id: "r1",
      questionId: "q1",
      repetition: 1,
      status: "failed",
      answerSource: {
        runId: "retry",
        resultId: "rr1",
        attemptId: "retry-attempt",
        evidenceHash: "h",
      },
    },
  ],
  attempts: [
    {
      id: "original-attempt",
      runId: "original",
      resultId: "r1",
      number: 1,
      status: "failed",
      startedAt: "2026-10-12T12:00:00Z",
      error: "Original tool failed.",
    },
    {
      id: "retry-attempt",
      runId: "retry",
      resultId: "rr1",
      number: 1,
      status: "completed",
      startedAt: "2026-10-12T12:01:00Z",
    },
  ],
  progress: { total: 1, completed: 1, failed: 0 },
  jevAssessments: [],
} as unknown as RunView;
const pass = (recovered: boolean) =>
  ({
    id: recovered ? "updated-score" : "original-score",
    observationRevision: recovered ? "updated-revision" : "original-revision",
    name: recovered ? "Updated deterministic" : "Original deterministic",
    source: "deterministic",
    basis: { bankRevisionId: "bank", evaluatorRevisionId: "eval" },
    configuration: {},
    coverage: {
      correct: recovered ? 1 : 0,
      judged: recovered ? 1 : 0,
      eligible: 1,
    },
    judgedAccuracy: recovered ? 1 : null,
    judgments: [
      {
        resultId: "r1",
        status: recovered ? "correct" : "unjudged",
        explanation: recovered ? "Matches reference." : "No answer submitted.",
        ...(recovered
          ? {
              attemptId: "retry-attempt",
              source: { runId: "retry", resultId: "rr1" },
            }
          : {}),
      },
    ],
  }) as FixturePass;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resource.mockReset();
  resource.mockImplementation(
    (_operation: string, input: { attemptId: string }) => ({
      data: {
        attempt: {
          ...view.attempts.find((item) => item.id === input.attemptId),
          ...(input.attemptId === "retry-attempt"
            ? { output: { answer: 42, text: "42" } }
            : {}),
        },
      },
      error: null,
      refresh: () => {},
    }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("shows the recovered verdict and its source instead of the original execution failure", async () => {
  await act(async () =>
    root.render(
      <RunQuestions
        view={view}
        pass={pass(true)}
        selectedResultId="r1"
        onSelectResult={() => {}}
        onInspectCapturedScore={() => {}}
        onReview={() => {}}
      />,
    ),
  );
  expect(container.textContent).toContain("Rerun answer from");
  expect(container.textContent).toContain("42");
  expect(
    container.querySelector(".queue-item > span:last-child > small")
      ?.textContent,
  ).toBe("correct");
  expect(resource).toHaveBeenCalledWith(
    "runs.attempt",
    { runId: "original", attemptId: "retry-attempt" },
    undefined,
    true,
  );
});
it("keeps original failed evidence when the original score is selected", async () => {
  await act(async () =>
    root.render(
      <RunQuestions
        view={view}
        pass={pass(false)}
        selectedResultId="r1"
        onSelectResult={() => {}}
        onInspectCapturedScore={() => {}}
        onReview={() => {}}
      />,
    ),
  );
  expect(container.textContent).not.toContain("Rerun answer from");
  expect(container.textContent).toContain(
    "No final answer recorded for this attempt.",
  );
  expect(
    container.querySelector(".queue-item > span:last-child > small")
      ?.textContent,
  ).toBe("failed");
  expect(resource).toHaveBeenCalledWith(
    "runs.attempt",
    { runId: "original", attemptId: "original-attempt" },
    undefined,
    true,
  );
});
it("permits human review of the applied answer without rewriting the original failure", async () => {
  await act(async () =>
    root.render(
      <ReviewDialog
        view={view}
        pass={pass(true)}
        resultId="r1"
        onClose={() => {}}
        onSaved={() => {}}
      />,
    ),
  );
  expect(document.body.textContent).toContain("Applied rerun answer");
  expect(
    document.querySelector<HTMLOptionElement>('option[value="correct"]')
      ?.disabled,
  ).toBe(false);
  expect(resource).toHaveBeenCalledWith(
    "runs.attempt",
    { runId: "original", attemptId: "retry-attempt" },
    undefined,
    true,
  );
  await act(async () =>
    root.render(
      <ReviewDialog
        view={view}
        pass={pass(false)}
        resultId="r1"
        onClose={() => {}}
        onSaved={() => {}}
      />,
    ),
  );
  expect(
    document.querySelector<HTMLOptionElement>('option[value="correct"]')
      ?.disabled,
  ).toBe(true);
});
it("does not enable verdict overrides for an old no-answer score after its result completes", async () => {
  const resumed = structuredClone(view);
  resumed.results[0] = {
    ...resumed.results[0]!,
    status: "completed",
    completedAttemptId: "later-attempt",
    answerSource: undefined,
  };
  resumed.attempts.push({
    ...resumed.attempts[0]!,
    id: "later-attempt",
    status: "completed",
    hasOutput: true,
  });
  await act(async () =>
    root.render(
      <ReviewDialog
        view={resumed}
        pass={pass(false)}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    ),
  );
  expect(
    document.querySelector<HTMLOptionElement>('option[value="correct"]')
      ?.disabled,
  ).toBe(true);
  expect(
    document.querySelector<HTMLOptionElement>('option[value="incorrect"]')
      ?.disabled,
  ).toBe(true);
  expect(document.body.textContent).toContain("No answer recorded.");
});
