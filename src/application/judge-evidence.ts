import { AnswerSources } from "./answer-sources.js";
import {
  jsonSchema,
  type BankRevision,
  type EvaluatorRevision,
  type JudgeEvidence,
  type Json,
} from "../contracts.js";
import { AppError } from "../domain/errors.js";
import { digest } from "../domain/identity.js";
import { savedTarget } from "../contracts/targets.js";
import { Database } from "../storage/database.js";

/** Reads complete sealed target evidence independently of every assessment. */
export function buildJudgeEvidence(
  db: Database,
  runId: string,
  attemptId: string,
  basis?: { evaluator: EvaluatorRevision; referenceBank?: BankRevision },
): JudgeEvidence {
  const run = db.require("run", runId);
  const { attempt, result } = new AnswerSources(db).authorize(runId, attemptId);
  if (attempt.status !== "completed" || !attempt.output || !attempt.finishedAt)
    throw new AppError(
      "evidence_unavailable",
      "Judging requires a completed attempt from this Run.",
    );
  if (digest(attempt.output) !== attempt.evidenceHash)
    throw new AppError(
      "evidence_integrity",
      "The sealed attempt evidence hash does not match.",
    );
  const question = (
    basis?.referenceBank?.questions ?? run.manifest.questions
  ).find((item) => item.id === result.questionId);
  if (!question)
    throw new AppError(
      "evidence_unavailable",
      "The frozen question is unavailable.",
    );
  const { expected, ...publicQuestion } = question;
  const target = savedTarget(run.manifest);
  const observationLevel =
    attempt.output.evidenceScope ??
    (target.kind === "external" ? "answer-only" : "internal-activity");
  let trace: JudgeEvidence["trace"];
  if (observationLevel === "answer-only")
    trace = { format: "unavailable", entries: null };
  else if (
    attempt.output.transcript !== undefined &&
    attempt.output.transcript !== null &&
    !(
      Array.isArray(attempt.output.transcript) &&
      attempt.output.transcript.length === 0
    )
  )
    trace = {
      format: "provider_transcript",
      entries: attempt.output.transcript,
    };
  else {
    const entries: Json[] = [];
    let cursor = 0;
    for (;;) {
      const page = db.events({ runId: attempt.runId, attemptId }, cursor, {
        limit: 5000,
      });
      for (const event of page)
        if (
          !/^(evaluation|judge|jev|review|research|assessment)\./.test(
            event.type,
          )
        )
          entries.push(jsonSchema.parse(event));
      if (page.length < 5000) break;
      cursor = page.at(-1)!.sequence;
    }
    trace = { format: "recorded_events", entries };
  }
  const { questionOverrides, ...base } = (
    basis?.evaluator ?? run.manifest.evaluator
  ).settings;
  const effective = { ...base, ...questionOverrides[question.id] };
  const { code: _code, ...referenceCriteria } = effective;
  return {
    schemaVersion: 1,
    runId,
    resultId: result.id,
    attemptId,
    repetition: result.repetition,
    question: publicQuestion,
    expected,
    finalAnswer: attempt.output.answer,
    finalText: attempt.output.text,
    publicTarget: target,
    observationLevel,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    ...(attempt.output.terminalReason
      ? { terminalReason: attempt.output.terminalReason }
      : {}),
    referenceCriteria: jsonSchema.parse({
      ...referenceCriteria,
      customEvaluation: effective.mode === "custom",
    }),
    trace,
  };
}
