import { buildJudgeEvidence } from "./judge-evidence.js";
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
  type RuntimePort,
} from "../contracts.js";
import { AppError, errorMessage } from "../domain/errors.js";
import { digest, id, now } from "../domain/identity.js";
import { Database } from "../storage/database.js";
import { evidenceSupports } from "../domain/evidence-requirements.js";

function evidenceForClassificationRequest(
  evidence: JudgeEvidence,
  requirement: JevProfileSettings["evidenceRequirement"],
): JudgeEvidence {
  if (requirement !== "answer") return evidence;
  return {
    ...evidence,
    observationLevel: "answer-only",
    trace: { format: "unavailable", entries: null },
  };
}

type JevFallback = NonNullable<JevAssessmentRecord["fallback"]>;
type JevFallbackTrigger = JevFallback["trigger"];

function fallbackTrigger(error: unknown): JevFallbackTrigger {
  const detail =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : {};
  const trigger: JevFallbackTrigger = {
    error: {
      code: typeof detail.code === "string" ? detail.code : "judge_error",
      message: errorMessage(error),
    },
  };
  for (const field of ["request", "response", "attempts"] as const)
    if (detail[field] !== undefined) {
      const parsed = jsonSchema.safeParse(detail[field]);
      if (parsed.success) trigger[field] = parsed.data;
    }
  if (typeof detail.requestId === "string")
    trigger.requestId = detail.requestId;
  if (typeof detail.httpStatus === "number")
    trigger.httpStatus = detail.httpStatus;
  if (detail.usage)
    trigger.usage = detail.usage as JevAssessmentRecord["usage"];
  if (detail.pricing)
    trigger.pricing = detail.pricing as JevAssessmentRecord["pricing"];
  return trigger;
}

function aggregateFallbackUsage(
  trigger: JevFallbackTrigger["usage"],
  result: JevAssessmentRecord["usage"],
): JevAssessmentRecord["usage"] {
  if (!trigger || !result) return undefined;
  const combined: NonNullable<JevAssessmentRecord["usage"]> = {};
  for (const key of [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "costUsd",
  ] as const) {
    const first = trigger[key];
    const second = result[key];
    if (first !== undefined && second !== undefined)
      combined[key] = first + second;
  }
  return Object.keys(combined).length ? combined : undefined;
}

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
    const evidence = buildJudgeEvidence(this.db, runId, attemptId, basis);
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
      const classifier = this.runtime.classifier;
      if (!classifier)
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
      const deadline = Date.now() + timeoutMs;
      let result: Awaited<ReturnType<typeof classifier.evaluate>>;
      try {
        result = await classifier.evaluate({
          configuration,
          criteria,
          evidence: evidenceForClassificationRequest(
            evidence,
            criteria.evidenceRequirement,
          ),
          timeoutMs,
          signal,
          onRequest: (request) => {
            record = this.db.update("jevAssessment", {
              ...record,
              request: jsonSchema.parse(request),
            });
          },
        });
      } catch (initialError) {
        const detail =
          typeof initialError === "object" && initialError !== null
            ? (initialError as Record<string, unknown>)
            : {};
        const traceIncluded =
          criteria.evidenceRequirement !== "answer" &&
          evidence.observationLevel === "internal-activity" &&
          evidence.trace.format !== "unavailable" &&
          evidence.trace.entries !== null;
        const canFallback =
          criteria.answerOnlyFallback !== undefined &&
          traceIncluded &&
          !signal.aborted &&
          (detail.code === "token_limit_exceeded" ||
            detail.code === "capacity_exceeded");
        const remainingMs = deadline - Date.now();
        if (!canFallback || remainingMs <= 0) throw initialError;
        const trigger = fallbackTrigger(initialError);
        if (trigger.request === undefined && record.request !== undefined)
          trigger.request = record.request;
        record = this.db.update("jevAssessment", {
          ...record,
          request: undefined,
          response: undefined,
          attempts: undefined,
          requestId: undefined,
          httpStatus: undefined,
          pricing: undefined,
          fallback: {
            trigger,
            criteria: criteria.answerOnlyFallback!,
          },
        });
        try {
          result = await classifier.evaluate({
            configuration,
            criteria,
            evidence,
            scope: "answer-only-fallback",
            timeoutMs: remainingMs,
            signal,
            onRequest: (request) => {
              record = this.db.update("jevAssessment", {
                ...record,
                request: jsonSchema.parse(request),
              });
            },
          });
          const usage = aggregateFallbackUsage(trigger.usage, result.usage);
          record = this.db.update("jevAssessment", {
            ...record,
            usage,
            fallback: {
              ...record.fallback!,
              resultUsage: result.usage,
            },
          });
        } catch (fallbackError) {
          const fallbackResult = fallbackTrigger(fallbackError);
          const usage = aggregateFallbackUsage(
            trigger.usage,
            fallbackResult.usage,
          );
          record = this.db.update("jevAssessment", {
            ...record,
            usage,
            fallback: {
              ...record.fallback!,
              resultUsage: fallbackResult.usage,
            },
          });
          throw fallbackError;
        }
      }
      const reviewRequired =
        !result.checks.evidence ||
        !result.checks.reference ||
        Object.values(result.checks).some(
          (check) => check.confidence < criteria.confidenceThreshold,
        ) ||
        result.checks.answer.choice === "insufficient_evidence" ||
        result.checks.evidence?.choice === "insufficient_evidence" ||
        (result.checks.answer.choice === "acceptable" &&
          result.checks.evidence?.choice === "contradicted") ||
        (result.checks.reference !== undefined &&
          result.checks.reference.choice !== "consistent");
      record = this.db.update("jevAssessment", {
        ...record,
        ...result,
        ...(record.fallback ? { usage: record.usage } : {}),
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
      if (detail.usage && !record.fallback)
        provenance.usage = detail.usage as JevAssessmentRecord["usage"];
      if (detail.pricing)
        provenance.pricing = detail.pricing as JevAssessmentRecord["pricing"];
      if (!record.fallback && !record.request && !provenance.request)
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
