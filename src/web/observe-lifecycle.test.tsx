// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type {
  AssessmentPassDetail,
  AttemptRecord,
  RunView,
} from "../contracts.js";
import { Observe } from "./observe.js";

it.each([
  { observeRunning: true, bodyUnavailable: false },
  { observeRunning: false, bodyUnavailable: false },
  { observeRunning: true, bodyUnavailable: true },
])(
  "keeps observed facts current when assessment or attempt detail fails: %j",
  async ({ observeRunning, bodyUnavailable }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let phase: "interrupted" | "running" | "completed" = "interrupted";
    let detailCalls = 0;
    const currentPass = (): AssessmentPassDetail => {
      const completed = phase === "completed";
      return {
        id: "original-pass",
        observationRevision: `revision-${phase}`,
        runId: "run",
        name: "Original deterministic",
        source: "deterministic",
        status: phase,
        createdAt: "2026-10-05T12:00:00Z",
        basis: {
          bankRevisionId: "bank",
          evaluatorRevisionId: "eval",
          referenceHash: "hash",
          eligibleResultIds: ["r1", "r2"],
          excludedResultIds: [],
        },
        configuration: {},
        judgments: [
          {
            resultId: "r1",
            attemptId: "a1",
            evidenceHash: "sealed-answer-a1",
            status: "correct",
            explanation: "42 matches the reference.",
          },
          completed
            ? {
                resultId: "r2",
                attemptId: "a3",
                evidenceHash: "sealed-answer-a3",
                status: "incorrect",
                explanation: "41 differs from the reference, 42.",
              }
            : {
                resultId: "r2",
                status: "unjudged",
                explanation: "No completed answer.",
              },
        ],
        coverage: {
          eligible: 2,
          answered: completed ? 2 : 1,
          judged: completed ? 2 : 1,
          correct: 1,
          incorrect: completed ? 1 : 0,
          unjudged: completed ? 0 : 1,
          errors: 0,
          excluded: 0,
          reviewed: 0,
          overridden: 0,
        },
        accuracy: completed ? 0.5 : 1,
        judgedAccuracy: completed ? 0.5 : 1,
      };
    };
    const attempts = (): AttemptRecord[] => [
      {
        id: "a1",
        runId: "run",
        resultId: "r1",
        number: 1,
        status: "completed",
        startedAt: "2026-10-05T12:00:00Z",
        finishedAt: "2026-10-05T12:00:01Z",
        output: { answer: 42, text: "42" },
        evidenceHash: "sealed-answer-a1",
      },
      {
        id: "a2",
        runId: "run",
        resultId: "r2",
        number: 1,
        status: "interrupted",
        startedAt: "2026-10-05T12:00:00Z",
        finishedAt: "2026-10-05T12:00:01Z",
      },
      ...(phase === "interrupted"
        ? []
        : [
            {
              id: "a3",
              runId: "run",
              resultId: "r2",
              number: 2,
              status: phase === "completed" ? "completed" : "running",
              startedAt: "2026-10-05T12:00:02Z",
              ...(phase === "completed"
                ? {
                    finishedAt: "2026-10-05T12:00:03Z",
                    output: { answer: 41, text: "41" },
                    evidenceHash: "sealed-answer-a3",
                  }
                : {}),
            } satisfies AttemptRecord,
          ]),
    ];
    const view = () =>
      ({
        run: {
          id: "run",
          name: "Resumed run",
          status: phase === "interrupted" ? "halted" : phase,
          createdAt: "2026-10-05T12:00:00Z",
          manifest: {
            bank: { id: "bank", bankId: "bank", name: "Bank", number: 1 },
            evaluator: { id: "eval", number: 1, name: "Exact", settings: {} },
            target: {
              kind: "external",
              adapterId: "generic-http",
              name: "Fixture",
            },
            repetitions: 1,
            questions: [
              { id: "q1", text: "Question one?", expected: 42 },
              { id: "q2", text: "Question two?", expected: 42 },
            ],
            judge: { enabled: false },
          },
        },
        results: [
          {
            id: "r1",
            questionId: "q1",
            repetition: 1,
            runId: "run",
            attemptIds: ["a1"],
            status: "completed",
            completedAttemptId: "a1",
          },
          {
            id: "r2",
            questionId: "q2",
            repetition: 1,
            runId: "run",
            attemptIds: phase === "interrupted" ? ["a2"] : ["a2", "a3"],
            status: phase === "completed" ? "completed" : phase,
            ...(phase === "completed" ? { completedAttemptId: "a3" } : {}),
          },
        ],
        attempts: attempts().map(({ output, ...attempt }) => ({
          ...attempt,
          hasOutput: !!output,
        })),
        assessmentPasses: [currentPass()],
        selectedAssessmentPassId: "original-pass",
        progress: {
          completed: phase === "completed" ? 2 : 1,
          total: 2,
          failed: phase === "interrupted" ? 1 : 0,
        },
        allowedActions: [],
        jevAssessments: [],
        reviews: [],
      }) as unknown as RunView;
    const request = vi.fn(async (url: string, options: RequestInit) => {
      const input = JSON.parse(options.body as string);
      if (url.endsWith("/runs.get") || url.endsWith("/runs.observe"))
        return Response.json(view());
      if (url.endsWith("/runs.assessment")) {
        detailCalls++;
        return detailCalls === 1
          ? Response.json(currentPass())
          : Response.json(
              { error: { message: "Completed detail unavailable." } },
              { status: 500 },
            );
      }
      if (
        url.endsWith("/runs.attempt") &&
        input.attemptId === "a3" &&
        phase === "completed" &&
        bodyUnavailable
      )
        return Response.json(
          { error: { message: "Saved answer temporarily unavailable." } },
          { status: 503 },
        );
      if (url.endsWith("/runs.attempt"))
        return Response.json({
          attempt: attempts().find((item) => item.id === input.attemptId),
          events: [],
        });
      if (url.endsWith("/runs.attempt-events"))
        return Response.json({ events: [], cursor: 0 });
      throw new Error(`Unexpected operation: ${url}`);
    });
    vi.stubGlobal("fetch", request);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const score = () =>
      container.querySelector('[aria-label="Selected saved score"]')!;
    const verdict = () =>
      container.querySelector(".grading-body .verdict")!.textContent;
    try {
      await act(async () =>
        root.render(
          <Observe
            runId="run"
            initialResultId="r2"
            refreshWorkspace={() => {}}
          />,
        ),
      );
      const queue = container.querySelector(".question-queue");
      expect(detailCalls).toBe(1);
      expect(score().textContent).toContain("100.0%");
      expect(verdict()).toContain("No completed answer.");
      if (observeRunning) {
        phase = "running";
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1500);
        });
        expect(
          score().querySelector(".selected-score-source")?.textContent,
        ).toContain("Running");
        expect(detailCalls).toBe(1);
      }
      phase = "completed";
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(detailCalls).toBe(2);
      expect(container.textContent).toContain("Completed detail unavailable.");
      expect(
        score().querySelector(".selected-score-source")?.textContent,
      ).toContain("Completed");
      expect(score().textContent).toContain("50.0%");
      expect(score().textContent).toContain("1 / 2 correct");
      expect(score().textContent).toContain("2 / 2 judged");
      expect(verdict()).toContain("Incorrect");
      expect(verdict()).toContain("41 differs from the reference, 42.");
      expect(
        container.querySelector(".observation-properties dd")?.textContent,
      ).toBe("completed");
      if (bodyUnavailable) {
        expect(
          container.querySelector(".activity-body")?.textContent,
        ).toContain("Could not load the saved answer.");
        bodyUnavailable = false;
        await act(async () =>
          Array.from(container.querySelectorAll("button"))
            .find((button) => button.textContent === "Retry loading answer")!
            .click(),
        );
      }
      expect(container.querySelector(".activity-body")?.textContent).toContain(
        "41",
      );
      expect(container.querySelector(".question-queue")).toBe(queue);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(score().textContent).toContain("50.0%");
      expect(verdict()).toContain("41 differs from the reference, 42.");
      expect(detailCalls).toBe(2);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  },
);
