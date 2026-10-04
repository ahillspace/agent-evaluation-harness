import { expect, it } from "vitest";
import {
  evaluatorSettingsSchema,
  judgeSchema,
  limitsSchema,
  type Assessment,
  type RunRecord,
  type AttemptRecord,
  type ResultRecord,
} from "../contracts.js";
import { digest } from "../domain/identity.js";
import { Database } from "../storage/database.js";
import { accuracy, gradedCount, EvaluationService } from "./evaluations.js";

it("reports the same denominator as accuracy and excludes unavailable grading", () => {
  const assessments: Assessment[] = ["correct", "incorrect", "error"].map(
    (status, index) => ({
      resultId: `result-${index}`,
      attemptId: `attempt-${index}`,
      deterministic: {
        status: status as Assessment["deterministic"]["status"],
        explanation: status,
      },
    }),
  );
  expect(gradedCount(assessments)).toBe(2);
  expect(accuracy(assessments)).toBe(0.5);
  expect(gradedCount([])).toBe(0);
  expect(accuracy([])).toBeNull();
});

it("marks saved answer-only evidence unavailable for internal checks and grades compatible answers", async () => {
  const db = new Database(":memory:");
  try {
    const evaluator = {
      id: "e",
      bankId: "b",
      number: 1,
      name: "Evaluator",
      createdAt: "",
      digest: "",
      settings: evaluatorSettingsSchema.parse({
        evidenceRequirement: "internal-activity",
      }),
    };
    const questions = [{ id: "q", text: "Question", expected: 42, tags: [] }];
    const run: RunRecord = {
      id: "run",
      name: "Run",
      createdAt: "",
      updatedAt: "",
      status: "completed",
      intent: "run",
      manifest: {
        target: {
          kind: "external",
          adapterId: "http",
          adapterVersion: 1,
          name: "Endpoint",
          configuration: {},
        },
        evaluator,
        questions,
        bank: {
          id: "bank-revision",
          bankId: "bank",
          number: 1,
          name: "Bank",
          createdAt: "",
          digest: "",
          questions,
        },
        repetitions: 1,
        judge: judgeSchema.parse({}),
        limits: limitsSchema.parse({}),
        digest: "",
      },
    };
    const result = { id: "result", questionId: "q" } as ResultRecord;
    const output = {
      answer: 42,
      text: "42",
      evidenceScope: "answer-only" as const,
    };
    const attempt = {
      id: "attempt",
      status: "completed",
      output,
      evidenceHash: digest(output),
    } as AttemptRecord;
    const service = new EvaluationService(db);
    expect(
      (await service.assess(run, result, attempt)).deterministic.status,
    ).toBe("unavailable");
    expect(
      (
        await service.assess(run, result, attempt, {
          ...evaluator,
          settings: evaluatorSettingsSchema.parse({}),
        })
      ).deterministic.status,
    ).toBe("correct");
  } finally {
    db.close();
  }
});
