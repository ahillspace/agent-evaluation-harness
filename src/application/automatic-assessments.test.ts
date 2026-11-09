import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import {
  agentSchema,
  connectionBindingSchema,
  jevProfileSettingsSchema,
  type JevAssessmentRecord,
  evaluatorSettingsSchema,
  judgeSchema,
  limitsSchema,
  type RunRecord,
  type RuntimePort,
} from "../contracts.js";
import { digest } from "../domain/identity.js";
import { Database } from "../storage/database.js";
import { AssessmentPassService } from "./assessment-passes.js";
import { EvaluationService } from "./evaluations.js";
import { JevService } from "./jev.js";

async function fixture(jevEnabled = false) {
  const directory = await mkdtemp(join(tmpdir(), "aeh-automatic-"));
  const db = new Database(join(directory, "workspace.sqlite"));
  const createdAt = "2026-11-01T00:00:00.000Z";
  const questions = ["correct", "incorrect", "failed"].map((id) => ({
    id,
    text: `${id}?`,
    expected: 42,
    tags: [],
  }));
  const run: RunRecord = {
    id: "run",
    name: "Run",
    createdAt,
    updatedAt: createdAt,
    status: "completed",
    intent: "run",
    execution: {
      id: "run",
      resultIds: questions.map((question) => question.id),
      controller: "run",
      createdAt,
    },
    manifest: {
      agent: agentSchema.parse({ harness: "codex", model: "fixture" }),
      bank: {
        id: "bank",
        bankId: "bank",
        number: 1,
        name: "Bank",
        createdAt,
        questions,
        digest: "bank",
      },
      evaluator: {
        id: "evaluator",
        bankId: "bank",
        number: 1,
        name: "Evaluator",
        createdAt,
        settings: evaluatorSettingsSchema.parse({}),
        digest: "evaluator",
      },
      questions,
      repetitions: 1,
      judge: judgeSchema.parse({
        enabled: true,
        agent: agentSchema.parse({ harness: "codex", model: "fixture-judge" }),
      }),
      limits: limitsSchema.parse({}),
      digest: "manifest",
    },
  };
  if (jevEnabled) {
    const criteria = jevProfileSettingsSchema.parse({});
    run.manifest.jevJudge = {
      connection: connectionBindingSchema.parse({
        connectionId: "fixture-jev",
      }),
      model: "jev-1.13.0",
      profile: {
        id: "profile",
        bankId: "bank",
        number: 1,
        name: "Profile",
        createdAt,
        settings: criteria,
        digest: "profile",
      },
    };
  }
  db.insert("run", run);
  for (const question of questions) {
    const attemptId = `first_${question.id}`;
    const completed = question.id !== "failed";
    const output = {
      answer: question.id === "correct" ? 42 : 41,
      text: "Answer",
    };
    db.insert("result", {
      id: question.id,
      runId: run.id,
      questionId: question.id,
      repetition: 1,
      status: completed ? "completed" : "failed",
      attemptIds: [attemptId],
      ...(completed ? { completedAttemptId: attemptId } : {}),
    });
    db.insert("attempt", {
      id: attemptId,
      runId: run.id,
      resultId: question.id,
      executionId: run.id,
      number: 1,
      startedAt: createdAt,
      finishedAt: createdAt,
      status: completed ? "completed" : "failed",
      ...(completed ? { output, evidenceHash: digest(output) } : {}),
    });
    if (completed)
      db.insert("assessment", {
        id: `assessment_${attemptId}`,
        runId: run.id,
        resultId: question.id,
        attemptId,
        deterministic: {
          status: question.id === "correct" ? "correct" : "incorrect",
          explanation: question.id,
        },
        judge: { verdict: question.id === "correct", explanation: question.id },
        judgeAdmitted: true,
      });
  }
  const runtime = {} as RuntimePort;
  const service = new AssessmentPassService(
    db,
    new EvaluationService(db),
    new JevService(db, runtime),
    runtime,
    directory,
  );
  return {
    db,
    run,
    service,
    async close() {
      db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it.each(["original", "recovery"] as const)(
  "freezes an interrupted %s family without changing its exported payload or revision across takeover and startup",
  async (family) => {
    const f = await fixture(true);
    try {
      if (family === "recovery") f.service.sealCurrent("run");
      const interrupted = {
        ...f.run,
        status: "halted" as const,
        intent: "halt" as const,
        execution: {
          ...f.run.execution!,
          id: family === "original" ? "run" : "research-continuation",
          controller: "research" as const,
        },
      };
      f.db.update("run", interrupted);
      const configuration = f.run.manifest.jevJudge!;
      const attempt = f.db.require("attempt", "first_correct");
      const evidence = {
        schemaVersion: 1 as const,
        runId: "run",
        resultId: "correct",
        attemptId: attempt.id,
        repetition: 1,
        question: { id: "correct", text: "correct?", tags: [] },
        referenceCriteria: {},
        expected: 42,
        finalAnswer: 42,
        finalText: attempt.output!.text,
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt!,
        trace: { format: "unavailable" as const, entries: [] },
      };
      f.db.insert("jevAssessment", {
        id: "settled-error",
        runId: "run",
        resultId: "correct",
        attemptId: attempt.id,
        createdAt: f.run.createdAt,
        finishedAt: f.run.updatedAt,
        kind: "original",
        status: "error",
        published: true,
        configuration,
        configurationHash: digest(configuration),
        criteria: configuration.profile.settings,
        evidence,
        evidenceHash: digest(evidence),
        attemptEvidenceHash: attempt.evidenceHash!,
        bankRevisionId: f.run.manifest.bank.id,
        evaluatorRevisionId: f.run.manifest.evaluator.id,
        request: { state: "recorded" },
        response: { error: "capacity" },
        error: { code: "fixture_capacity", message: "Recorded capacity error" },
        httpStatus: 422,
      });
      const before = ["deterministic", "llm", "jev"].map((source) =>
        f.service.read(
          "run",
          f.service.currentAutomaticId(
            "run",
            source as "deterministic" | "llm" | "jev",
          ),
        ),
      );
      for (const pass of before) {
        expect(pass.status).toBe("interrupted");
        expect(pass).not.toHaveProperty("finishedAt");
      }
      f.service.freezeCurrent("run");
      for (const pass of before) {
        expect(f.service.read("run", pass.id)).toEqual(pass);
        expect(
          f.service.read("run", pass.id, pass.observationRevision),
        ).toEqual(pass);
      }
      const manual = {
        ...interrupted,
        status: "running" as const,
        intent: "run" as const,
        execution: {
          ...interrupted.execution,
          id: "manual-takeover",
          controller: "run" as const,
        },
      };
      f.db.update("run", manual);
      for (const pass of before)
        expect(
          f.service.read("run", pass.id, pass.observationRevision),
        ).toEqual(pass);
      f.db.update("run", {
        ...manual,
        status: "completed",
        execution: {
          ...manual.execution,
          settledAt: "2026-11-03T00:00:00.000Z",
        },
      });
      f.service.sealCurrent("run");
      const completedId = f.service.currentAutomaticId("run");
      const completed = f.service.read("run", completedId);
      expect(completed).toMatchObject({
        status: "completed",
        finishedAt: "2026-11-03T00:00:00.000Z",
      });
      f.service.recover();
      expect(
        f.service.read("run", completedId, completed.observationRevision),
      ).toEqual(completed);
      for (const pass of before)
        expect(
          f.service.read("run", pass.id, pass.observationRevision),
        ).toEqual(pass);
      const savedJev = f.db
        .require("assessmentPass", before[2]!.id)
        .judgments.find((judgment) => judgment.resultId === "correct")!;
      expect(savedJev).toMatchObject({
        jevAssessmentId: "settled-error",
        jevAssessmentStatus: "error",
      });
      expect(savedJev).not.toHaveProperty("error");
      expect(savedJev).not.toHaveProperty("request");
      expect(savedJev).not.toHaveProperty("response");
    } finally {
      await f.close();
    }
  },
);

it("persists the completed raw first-family projection for a drained halted scope during startup", async () => {
  const f = await fixture();
  try {
    const settledAt = "2026-11-03T00:00:00.000Z";
    f.db.update("run", {
      ...f.run,
      status: "halted",
      intent: "halt",
      execution: { ...f.run.execution!, settledAt },
    });
    const passId = f.service.currentAutomaticId("run");
    const before = f.service.read("run", passId);
    expect(before).toMatchObject({
      status: "completed",
      finishedAt: settledAt,
    });
    expect(f.db.get("assessmentPass", passId)).toBeUndefined();
    f.service.recover();
    expect(f.db.require("assessmentPass", passId)).toMatchObject({
      status: "completed",
      finishedAt: settledAt,
    });
    expect(f.service.read("run", passId, before.observationRevision)).toEqual(
      before,
    );
    f.service.sealCurrent("run");
    expect(f.service.read("run", passId, before.observationRevision)).toEqual(
      before,
    );
  } finally {
    await f.close();
  }
});

it("keeps first automatic scores frozen and seals the current all-slot family independently of the Run status", async () => {
  const f = await fixture();
  try {
    expect(f.service.currentAutomaticId("run")).toBe(
      "original_deterministic_run",
    );
    f.service.sealCurrent("run");
    const first = f.service.original("run");
    const updated = {
      ...f.run,
      status: "halted" as const,
      execution: {
        ...f.run.execution!,
        id: "recovery",
        resultIds: ["failed"],
        createdAt: "2026-11-02T00:00:00.000Z",
      },
    };
    f.db.update("run", updated);
    const output = { answer: 42, text: "Recovered" };
    f.db.insert("attempt", {
      id: "recovered",
      runId: "run",
      resultId: "failed",
      executionId: "recovery",
      number: 2,
      status: "completed",
      startedAt: updated.execution.createdAt,
      finishedAt: updated.execution.createdAt,
      output,
      evidenceHash: digest(output),
    });
    f.db.update("result", {
      ...f.db.require("result", "failed"),
      status: "completed",
      completedAttemptId: "recovered",
      attemptIds: ["first_failed", "recovered"],
    });
    f.db.insert("assessment", {
      id: "recovered_assessment",
      runId: "run",
      resultId: "failed",
      attemptId: "recovered",
      deterministic: {
        status: "correct",
        explanation: "Recovered raw verdict",
      },
      judge: { verdict: true },
      judgeAdmitted: true,
    });
    const currentId = f.service.currentAutomaticId("run");
    expect(currentId).toBe("automatic_deterministic_recovery");
    expect(f.service.get("run", currentId).coverage).toMatchObject({
      eligible: 3,
      answered: 3,
      correct: 2,
      incorrect: 1,
    });
    expect(f.service.original("run")).toEqual(first);
    expect(f.service.originalDeterministicVerdicts("run").has("failed")).toBe(
      false,
    );
    expect(
      f.service.currentDeterministicVerdicts("run").get("failed"),
    ).toMatchObject({
      status: "correct",
      explanation: "Recovered raw verdict",
    });
    f.service.sealCurrent("run");
    expect(f.db.get("assessmentPass", currentId)).toBeUndefined();
    f.db.update("run", {
      ...f.db.require("run", "run"),
      execution: {
        ...updated.execution,
        settledAt: "2026-11-02T00:00:01.000Z",
      },
    });
    f.service.sealCurrent("run");
    expect(f.db.require("assessmentPass", currentId)).toMatchObject({
      status: "completed",
      coverage: { eligible: 3, correct: 2, incorrect: 1 },
    });
    const llm = f.service.get(
      "run",
      f.service.currentAutomaticId("run", "llm"),
    );
    expect(
      llm.judgments.find((judgment) => judgment.attemptId === "first_correct")
        ?.judgmentId,
    ).toBe("original_llm_first_correct");
    expect(
      f.service.summaries("run").find((pass) => pass.id === currentId)
        ?.coverage,
    ).toEqual(f.service.get("run", currentId).coverage);
  } finally {
    await f.close();
  }
});

it("reconstructs a missing first family from first execution evidence rather than later completed attempts", async () => {
  const f = await fixture();
  try {
    f.db.update("run", {
      ...f.run,
      execution: { ...f.run.execution!, id: "recovery" },
    });
    const output = { answer: 42, text: "Later" };
    f.db.insert("attempt", {
      id: "later",
      runId: "run",
      resultId: "failed",
      executionId: "recovery",
      number: 2,
      startedAt: f.run.createdAt,
      finishedAt: f.run.createdAt,
      status: "completed",
      output,
      evidenceHash: digest(output),
    });
    f.db.update("result", {
      ...f.db.require("result", "failed"),
      status: "completed",
      completedAttemptId: "later",
      attemptIds: ["first_failed", "later"],
    });
    f.db.insert("assessment", {
      id: "later_assessment",
      runId: "run",
      resultId: "failed",
      attemptId: "later",
      deterministic: { status: "correct", explanation: "Later verdict" },
    });
    f.service.recover();
    expect(f.service.original("run").coverage).toMatchObject({
      answered: 2,
      correct: 1,
      incorrect: 1,
    });
    expect(
      f.service.get("run", f.service.currentAutomaticId("run")).coverage,
    ).toMatchObject({ answered: 3, correct: 2 });
  } finally {
    await f.close();
  }
});

it("keeps legacy first verdicts canonical while current preview reads physical automatic verdicts", async () => {
  const f = await fixture();
  try {
    const assessments = f.db
      .list("assessment", { runId: "run" })
      .map((assessment) => ({
        ...assessment,
        deterministic: {
          ...assessment.deterministic,
          explanation: "Frozen legacy verdict",
        },
      }));
    f.db.insert("scoreSet", {
      id: "original_run",
      runId: "run",
      evaluator: f.run.manifest.evaluator,
      createdAt: f.run.createdAt,
      kind: "original",
      published: true,
      assessments,
    });
    f.service.sealCurrent("run");
    expect(
      f.service.originalDeterministicVerdicts("run").get("correct")
        ?.explanation,
    ).toBe("Frozen legacy verdict");
    f.db.update("run", {
      ...f.run,
      execution: { ...f.run.execution!, id: "recovery" },
    });
    expect(
      f.service.currentDeterministicVerdicts("run").get("correct")?.explanation,
    ).toBe("correct");
    const historical = f.db.insert("scoreSet", {
      id: "historical",
      runId: "run",
      evaluator: f.run.manifest.evaluator,
      createdAt: f.run.createdAt,
      kind: "rescore",
      published: true,
      assessments,
    });
    const snapshot = f.service.snapshotLegacyScore("run", historical.id);
    expect(snapshot.id).toBe("scores_historical");
    expect(f.service.snapshotLegacyScore("run", historical.id)).toEqual(
      snapshot,
    );
  } finally {
    await f.close();
  }
});

it.each(["raw", "legacy"] as const)(
  "binds adopted %s physical assessments exactly without borrowing a later saved judgment",
  async (storage) => {
    const f = await fixture(true);
    try {
      const configuration = f.run.manifest.jevJudge!;
      const criteria = configuration.profile.settings;
      f.service.sealCurrent("run");
      const recovery = {
        ...f.run,
        execution: { ...f.run.execution!, id: "recovery" },
      };
      f.db.update("run", recovery);
      const retry = {
        ...f.run,
        id: "retry",
        retryOf: { runId: "run", resultIds: ["failed"] },
      };
      f.db.insert("run", retry);
      const output = { answer: 42, text: "Adopted" };
      f.db.insert("result", {
        id: "retry_failed",
        runId: "retry",
        questionId: "failed",
        repetition: 1,
        status: "completed",
        completedAttemptId: "adopted",
        attemptIds: ["adopted"],
      });
      f.db.insert("attempt", {
        id: "adopted",
        runId: "retry",
        resultId: "retry_failed",
        number: 1,
        startedAt: f.run.createdAt,
        finishedAt: f.run.createdAt,
        status: "completed",
        output,
        evidenceHash: digest(output),
      });
      f.db.insert("retryApplication", {
        id: "applied",
        runId: "run",
        retryRunId: "retry",
        createdAt: f.run.createdAt,
        bindings: [
          {
            resultId: "failed",
            source: {
              runId: "retry",
              resultId: "retry_failed",
              attemptId: "adopted",
              evidenceHash: digest(output),
            },
          },
        ],
        assessmentPassIds: [],
      });
      f.db.insert("assessment", {
        id: "wrong_owner",
        runId: "run",
        resultId: "failed",
        attemptId: "adopted",
        deterministic: { status: "incorrect", explanation: "Wrong owner" },
      });
      const physicalAssessment = {
        resultId: "retry_failed",
        attemptId: "adopted",
        deterministic: {
          status: "correct" as const,
          explanation: "Physical raw verdict",
        },
        judge: { verdict: false, explanation: "Physical LLM" },
        judgeAdmitted: true,
      };
      if (storage === "raw")
        f.db.insert("assessment", {
          ...physicalAssessment,
          id: "physical",
          runId: "retry",
        });
      else
        f.db.insert("scoreSet", {
          id: "legacy_retry_original",
          runId: "retry",
          evaluator: f.run.manifest.evaluator,
          createdAt: f.run.createdAt,
          kind: "original",
          published: true,
          assessments: [physicalAssessment],
        });
      const jev: JevAssessmentRecord = {
        id: "physical_jev",
        runId: "retry",
        resultId: "retry_failed",
        attemptId: "adopted",
        createdAt: f.run.createdAt,
        finishedAt: f.run.createdAt,
        kind: "original",
        status: "completed",
        published: true,
        request: { provenance: "physical request" },
        response: { provenance: "physical response" },
        configuration,
        configurationHash: digest(configuration),
        evidenceHash: "judge-evidence",
        attemptEvidenceHash: digest(output),
        bankRevisionId: "bank",
        evaluatorRevisionId: "evaluator",
        criteria,
        evidence: {
          schemaVersion: 1,
          runId: "retry",
          resultId: "retry_failed",
          attemptId: "adopted",
          repetition: 1,
          question: { id: "failed", text: "failed?", tags: [] },
          referenceCriteria: {},
          expected: 42,
          finalAnswer: 42,
          finalText: "Adopted",
          startedAt: f.run.createdAt,
          finishedAt: f.run.createdAt,
          trace: { format: "unavailable", entries: [] },
        },
        checks: {
          answer: {
            choice: "acceptable",
            confidence: 1,
            probabilities: { acceptable: 1 },
          },
        },
      };
      f.db.insert("jevAssessment", {
        ...jev,
        id: "wrong_hash_jev",
        attemptEvidenceHash: "wrong",
        checks: {
          answer: {
            choice: "incorrect",
            confidence: 1,
            probabilities: { incorrect: 1 },
          },
        },
      });
      f.db.insert("jevAssessment", {
        ...jev,
        id: "rejudged_jev",
        kind: "rejudge",
        checks: {
          answer: {
            choice: "incorrect",
            confidence: 1,
            probabilities: { incorrect: 1 },
          },
        },
      });
      f.db.insert("jevAssessment", jev);
      const currentId = f.service.currentAutomaticId("run");
      const preview = f.service.previewSnapshot("run");
      expect(preview.passId).toBe(currentId);
      expect(
        preview.answers.find((answer) => answer.result.id === "failed"),
      ).toMatchObject({
        source: {
          runId: "retry",
          resultId: "retry_failed",
          attemptId: "adopted",
          evidenceHash: digest(output),
        },
        before: { status: "correct", explanation: "Physical raw verdict" },
      });
      expect(
        preview.answers.find((answer) => answer.result.id === "incorrect")
          ?.before?.status,
      ).toBe("incorrect");
      const realParse = JSON.parse;
      const bodyReads: string[] = [];
      const parseSpy = vi
        .spyOn(JSON, "parse")
        .mockImplementation((text, reviver) => {
          if (text.includes("PRIVATE_ADOPTED".repeat(1000)))
            bodyReads.push("adopted evidence");
          return realParse(text, reviver);
        });
      let compact;
      let compactFamily;
      try {
        compactFamily = f.service.list("run");
        compact = compactFamily.find((pass) => pass.id === currentId)!;
        expect(
          f.service.summaries("run").find((pass) => pass.id === currentId)
            ?.coverage,
        ).toEqual(compact.coverage);
        expect(bodyReads).toEqual([]);
      } finally {
        parseSpy.mockRestore();
      }
      for (const pass of compactFamily.filter((pass) =>
        pass.id.startsWith("automatic_"),
      )) {
        expect(
          f.service.read("run", pass.id, pass.observationRevision)
            .observationRevision,
        ).toBe(pass.observationRevision);
      }
      expect(
        f.service.read("run", currentId, compact.observationRevision)
          .observationRevision,
      ).toBe(compact.observationRevision);
      expect(
        f.service
          .get("run", f.service.currentAutomaticId("run", "jev"))
          .judgments.find((judgment) => judgment.resultId === "failed"),
      ).toMatchObject({
        status: "correct",
        jevAssessmentId: "physical_jev",
        source: { runId: "retry", resultId: "retry_failed" },
        evidenceHash: digest(output),
      });
      expect(
        f.service
          .get("run", currentId)
          .judgments.find((judgment) => judgment.resultId === "failed"),
      ).toMatchObject({
        attemptId: "adopted",
        evidenceHash: digest(output),
        source: { runId: "retry", resultId: "retry_failed" },
        status: "correct",
        explanation: "Physical raw verdict",
      });
      expect(
        f.service.currentDeterministicVerdicts("run").get("failed")
          ?.explanation,
      ).toBe("Physical raw verdict");
      expect(
        f.service
          .get("run", f.service.currentAutomaticId("run", "llm"))
          .judgments.find((judgment) => judgment.resultId === "failed"),
      ).toMatchObject({
        status: "incorrect",
        explanation: "Physical LLM",
        judgmentId: "original_llm_adopted",
      });
      f.service.sealCurrent("run");
      const jevPassId = f.service.currentAutomaticId("run", "jev");
      const storedJev = f.db
        .require("assessmentPass", jevPassId)
        .judgments.find((judgment) => judgment.resultId === "failed")!;
      expect(storedJev).not.toHaveProperty("request");
      expect(storedJev).not.toHaveProperty("response");
      expect(storedJev).not.toHaveProperty("error");
      expect(
        f.service
          .get("run", jevPassId)
          .judgments.find((judgment) => judgment.resultId === "failed"),
      ).toMatchObject({
        request: { provenance: "physical request" },
        response: { provenance: "physical response" },
      });
      const frozen = f.service.get("run", currentId);
      f.db.insert("assessment", {
        id: "later_substitute",
        runId: "retry",
        resultId: "retry_failed",
        attemptId: "adopted",
        deterministic: {
          status: "incorrect",
          explanation: "Later substitution",
        },
      });
      expect(f.service.get("run", currentId)).toEqual(frozen);
    } finally {
      await f.close();
    }
  },
);
