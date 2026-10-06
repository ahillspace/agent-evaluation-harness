import {
  jsonSchema,
  jevProfileSettingsSchema,
  type CommandInput,
  type EvaluatorRevision,
  type BankRevision,
  type FrozenJevJudge,
  type JudgeEvidence,
  type JevAssessmentRecord,
  type JevJudgeSelection,
  type JevProfileRevision,
  type JevProfileSettings,
  type Json,
  type RuntimePort,
} from "../contracts.js";
import { AppError, errorMessage } from "../domain/errors.js";
import { digest, id, now } from "../domain/identity.js";
import { Database } from "../storage/database.js";
import { savedTarget } from "../contracts/targets.js";
import { evidenceSupports } from "../domain/evidence-requirements.js";

export class JevService {
  constructor(
    private readonly db: Database,
    private readonly runtime: RuntimePort,
  ) {}
  async recover(): Promise<void> {
    for (const assessment of this.db.list("jevAssessment", {
      status: "pending",
    }))
      this.db.update("jevAssessment", {
        ...assessment,
        status: "error",
        finishedAt: now(),
        reviewRequired: true,
        error: {
          code: "interrupted",
          message:
            "The engine stopped before the classification response was saved. Usage is unknown; the request was not retried.",
        },
      });
    for (const attempt of this.db.list("attempt", { status: "completed" })) {
      const run = this.db.require("run", attempt.runId);
      if (
        !run.manifest.jevJudge ||
        this.db
          .list("jevAssessment", { resultId: attempt.resultId })
          .some(
            (record) =>
              record.attemptId === attempt.id && record.kind === "original",
          )
      )
        continue;
      await this.evaluate(
        run.id,
        attempt.id,
        run.manifest.jevJudge,
        "original",
        true,
        new AbortController().signal,
        {
          code: "not_evaluated",
          message:
            "The engine stopped after sealing the answer and before Jev admission. No classification request was sent.",
        },
      );
    }
  }
  publishProfile(input: {
    bankId: string;
    name: string;
    settings: JevProfileSettings;
    activate: boolean;
  }): JevProfileRevision {
    this.db.require("bank", input.bankId);
    return this.db.transaction(() => {
      const revisions = this.db.list("jevProfile", { bankId: input.bankId });
      const profile = this.db.insert("jevProfile", {
        id: id("jevprofile"),
        bankId: input.bankId,
        number: Math.max(0, ...revisions.map((value) => value.number)) + 1,
        name: input.name,
        settings: input.settings,
        createdAt: now(),
        digest: digest(input.settings),
      });
      if (input.activate) this.activate(input.bankId, profile.id);
      return profile;
    });
  }
  activate(bankId: string, profileRevisionId: string) {
    const bank = this.db.require("bank", bankId);
    const profile = this.db.require("jevProfile", profileRevisionId);
    if (profile.bankId !== bankId)
      throw new AppError(
        "invalid_input",
        "The Jev profile belongs to another bank.",
      );
    return this.db.update("bank", {
      ...bank,
      activeJevProfileRevisionId: profile.id,
    });
  }
  async resolve(
    bankId: string,
    selection: JevJudgeSelection,
  ): Promise<FrozenJevJudge> {
    const bank = this.db.require("bank", bankId);
    const profileId =
      selection.profileRevisionId ?? bank.activeJevProfileRevisionId;
    if (!profileId)
      throw new AppError(
        "invalid_input",
        "Publish a Jev profile for this bank before enabling Jev.",
      );
    const profile = this.db.require("jevProfile", profileId);
    if (profile.bankId !== bankId)
      throw new AppError(
        "invalid_input",
        "The Jev profile belongs to another bank.",
      );
    if (!this.runtime.classifier)
      throw new AppError(
        "unavailable",
        "No classification judge is configured.",
      );
    return {
      profile,
      model: selection.model,
      connection: await this.runtime.classifier.resolveConnection(
        selection.connectionId,
      ),
    };
  }
  private evidence(
    runId: string,
    attemptId: string,
    basis?: { evaluator: EvaluatorRevision; referenceBank?: BankRevision },
  ): JudgeEvidence {
    const run = this.db.require("run", runId);
    const attempt = this.db.require("attempt", attemptId);
    if (
      attempt.runId !== runId ||
      attempt.status !== "completed" ||
      !attempt.output ||
      !attempt.finishedAt
    )
      throw new AppError(
        "evidence_unavailable",
        "Jev requires a completed attempt from this Run.",
      );
    if (digest(attempt.output) !== attempt.evidenceHash)
      throw new AppError(
        "evidence_integrity",
        "The sealed attempt evidence hash does not match.",
      );
    const result = this.db.require("result", attempt.resultId);
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
        const page = this.db.events({ runId, attemptId }, cursor, {
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
  async preview(
    input: CommandInput<"jev.preview">,
  ): Promise<JevAssessmentRecord> {
    const hash = digest(input);
    const key = input.idempotencyKey
      ? `jev:${input.idempotencyKey}`
      : undefined;
    if (key) {
      const existing = this.db.idempotent(key, hash);
      if (existing) return this.db.require("jevAssessment", existing.id);
    }
    const run = this.db.require("run", input.runId);
    const configuration = input.configuration
      ? await this.resolve(run.manifest.bank.bankId, {
          ...input.configuration,
          model: input.configuration.model ?? "jev-1.13.0",
        })
      : run.manifest.jevJudge;
    if (!configuration)
      throw new AppError(
        "invalid_input",
        "Select a Jev connection and profile for this saved Run.",
      );
    return this.evaluate(
      input.runId,
      input.attemptId,
      configuration,
      "rejudge",
      false,
      new AbortController().signal,
      undefined,
      key ? { key, hash } : undefined,
    );
  }
  publish(assessmentId: string): JevAssessmentRecord {
    const record = this.db.require("jevAssessment", assessmentId);
    if (record.status === "pending")
      throw new AppError(
        "invalid_state",
        "Wait for the classification request to finish before publishing.",
      );
    if (record.published) return record;
    return this.db.update("jevAssessment", { ...record, published: true });
  }
  async evaluate(
    runId: string,
    attemptId: string,
    configuration: FrozenJevJudge,
    kind: "original" | "rejudge",
    published: boolean,
    signal: AbortSignal,
    admissionError?: { code: string; message: string },
    idempotency?: { key: string; hash: string },
    basis?: { evaluator: EvaluatorRevision; referenceBank?: BankRevision },
  ): Promise<JevAssessmentRecord> {
    const evidence = this.evidence(runId, attemptId, basis);
    const override =
      configuration.profile.settings.questionOverrides[evidence.question.id];
    const criteria = jevProfileSettingsSchema.parse({
      ...configuration.profile.settings,
      ...override,
      checks: Object.fromEntries(
        Object.entries(configuration.profile.settings.checks).map(
          ([key, check]) => {
            const replacement =
              override?.checks?.[
                key as keyof typeof configuration.profile.settings.checks
              ];
            return [
              key,
              {
                ...check,
                ...replacement,
                criteria: { ...check.criteria, ...replacement?.criteria },
              },
            ];
          },
        ),
      ),
      questionOverrides: {},
    });
    const run = this.db.require("run", runId);
    const created = this.db.transaction(() => {
      if (idempotency) {
        const found = this.db.idempotent(idempotency.key, idempotency.hash);
        if (found)
          return {
            record: this.db.require("jevAssessment", found.id),
            exists: true,
          };
      }
      const record = this.db.insert("jevAssessment", {
        id: id("jevassessment"),
        runId,
        resultId: evidence.resultId,
        attemptId,
        createdAt: now(),
        kind,
        status: "pending",
        published,
        configuration,
        configurationHash: digest(configuration),
        evidenceHash: digest(evidence),
        attemptEvidenceHash: this.db.require("attempt", attemptId)
          .evidenceHash!,
        bankRevisionId: basis?.referenceBank?.id ?? run.manifest.bank.id,
        evaluatorRevisionId: basis?.evaluator.id ?? run.manifest.evaluator.id,
        evidence,
        criteria,
      });
      if (idempotency)
        this.db.remember(
          idempotency.key,
          idempotency.hash,
          "jevAssessment",
          record.id,
        );
      return { record, exists: false };
    });
    if (created.exists) return created.record;
    let record = created.record;
    this.db.append({
      runId,
      attemptId,
      type: "jev.started",
      message: "Jev classification started.",
      data: { assessmentId: record.id },
    });
    try {
      if (admissionError)
        throw new AppError(admissionError.code, admissionError.message);
      if (
        !evidenceSupports(
          evidence.observationLevel ?? "internal-activity",
          criteria.evidenceRequirement ?? "unspecified",
        )
      )
        throw new AppError(
          "unsupported_evidence",
          "The saved evidence cannot satisfy this Jev profile. Publish an answer-compatible profile; no classification request was sent.",
        );
      if (signal.aborted)
        throw new AppError(
          "interrupted",
          "Jev was interrupted before admission.",
        );
      if (!this.runtime.classifier)
        throw new AppError(
          "unavailable",
          "No classification judge is configured.",
        );
      const parent = run.researchSessionId
        ? this.db.require("research", run.researchSessionId)
        : undefined;
      const timeoutMs = parent
        ? Math.max(
            1,
            Math.min(
              run.manifest.limits.timeoutMs,
              Date.parse(parent.createdAt) +
                parent.configuration.maxDurationMs -
                Date.now(),
            ),
          )
        : run.manifest.limits.timeoutMs;
      const result = await this.runtime.classifier.evaluate({
        configuration,
        criteria,
        evidence,
        timeoutMs,
        signal,
        onRequest: (request) => {
          record = this.db.update("jevAssessment", {
            ...record,
            request: jsonSchema.parse(request),
          });
        },
      });
      const reviewRequired =
        Object.values(result.checks).some(
          (check) => check.confidence < criteria.confidenceThreshold,
        ) ||
        result.checks.answer.choice === "insufficient_evidence" ||
        result.checks.evidence.choice === "insufficient_evidence" ||
        (result.checks.answer.choice === "acceptable" &&
          result.checks.evidence.choice === "contradicted") ||
        result.checks.reference.choice !== "consistent";
      record = this.db.update("jevAssessment", {
        ...record,
        ...result,
        status: "completed",
        finishedAt: now(),
        reviewRequired,
      });
    } catch (error) {
      const detail =
        typeof error === "object" && error !== null
          ? (error as Record<string, unknown>)
          : {};
      const provenance: Partial<JevAssessmentRecord> = {};
      for (const field of ["request", "response", "attempts"] as const)
        if (detail[field] !== undefined) {
          const parsed = jsonSchema.safeParse(detail[field]);
          if (parsed.success) provenance[field] = parsed.data;
        }
      if (typeof detail.requestId === "string")
        provenance.requestId = detail.requestId;
      if (typeof detail.httpStatus === "number")
        provenance.httpStatus = detail.httpStatus;
      if (detail.usage)
        provenance.usage = detail.usage as JevAssessmentRecord["usage"];
      if (detail.pricing)
        provenance.pricing = detail.pricing as JevAssessmentRecord["pricing"];
      if (!record.request && !provenance.request)
        provenance.usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
      record = this.db.update("jevAssessment", {
        ...record,
        ...provenance,
        status: "error",
        finishedAt: now(),
        reviewRequired: true,
        error: {
          code: typeof detail.code === "string" ? detail.code : "judge_error",
          message: errorMessage(error),
        },
      });
    }
    this.db.append({
      runId,
      attemptId,
      type: "jev.completed",
      message:
        record.status === "error"
          ? "Jev classification is unavailable."
          : "Jev classification saved.",
      data: { assessmentId: record.id, status: record.status },
    });
    return record;
  }
}
