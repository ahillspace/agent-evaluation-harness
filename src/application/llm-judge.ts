import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  jsonSchema,
  judgeInvocationSchema,
  judgeVerdictSchema,
  type Assessment,
  type BankRevision,
  type EvaluatorRevision,
  type JudgeConfig,
  type RuntimePort,
} from "../contracts.js";
import { AppError, errorMessage } from "../domain/errors.js";
import { evidenceSupports } from "../domain/evidence-requirements.js";
import { Database } from "../storage/database.js";
import { buildJudgeEvidence } from "./judge-evidence.js";
import { checkResearchBudget } from "./research-budget.js";

type JudgeAssessment = Pick<
  Assessment,
  | "judge"
  | "judgeError"
  | "judgeRequest"
  | "judgeResponse"
  | "judgeUsage"
  | "judgeAdmitted"
>;

/** Original and saved LLM assessments share evidence, admission, and durable outcomes. */
export class LlmJudgeService {
  constructor(
    private readonly db: Database,
    private readonly runtime: RuntimePort,
  ) {}

  async evaluate(input: {
    runId: string;
    attemptId: string;
    configuration: JudgeConfig;
    artifactDirectory: string;
    signal: AbortSignal;
    original?: boolean;
    pass?: { id: string; judgmentId: string; index: number };
    basis?: { evaluator: EvaluatorRevision; referenceBank?: BankRevision };
  }): Promise<JudgeAssessment> {
    const assessment: JudgeAssessment = { judgeAdmitted: false };
    try {
      const run = this.db.require("run", input.runId);
      const evidence = buildJudgeEvidence(
        this.db,
        run.id,
        input.attemptId,
        input.basis,
      );
      if (
        !evidenceSupports(
          evidence.observationLevel ?? "answer-only",
          input.configuration.evidenceRequirement ?? "unspecified",
        )
      )
        throw new AppError(
          "unsupported_evidence",
          "The selected judge requires evidence unavailable in this run.",
        );
      const requestEvidence =
        input.configuration.evidenceRequirement === "answer"
          ? {
              ...evidence,
              observationLevel: "answer-only" as const,
              trace: { format: "unavailable" as const, entries: null },
            }
          : evidence;
      assessment.judgeRequest = jsonSchema.parse({
        configuration: input.configuration,
        evidence: requestEvidence,
      });
      await mkdir(input.artifactDirectory, { recursive: true });
      await writeFile(
        join(input.artifactDirectory, "request.json"),
        JSON.stringify(assessment.judgeRequest),
        "utf8",
      );
      // The last admission check and durable checkpoint are synchronous, including concurrent judges.
      if (input.signal.aborted)
        throw new AppError(
          "interrupted",
          "Judge interrupted before admission.",
        );
      let timeoutMs = run.manifest.limits.timeoutMs;
      if (input.original && run.researchSessionId) {
        const parent = this.db.require("research", run.researchSessionId);
        const budget = checkResearchBudget(this.db, parent, 0, run.id);
        if (budget) throw new AppError("budget_exhausted", budget);
        timeoutMs = Math.max(
          1,
          Math.min(
            timeoutMs,
            Date.parse(parent.createdAt) +
              parent.configuration.maxDurationMs -
              Date.now(),
          ),
        );
      }
      if (input.pass) {
        const pass = this.db.require("assessmentPass", input.pass.id);
        this.db.update("assessmentPass", {
          ...pass,
          judgments: pass.judgments.map((judgment, index) =>
            index === input.pass!.index
              ? {
                  ...judgment,
                  judgmentId: input.pass!.judgmentId,
                  request: assessment.judgeRequest,
                }
              : judgment,
          ),
        });
      } else {
        this.db.append({
          runId: run.id,
          attemptId: input.attemptId,
          type: "judge.request",
          message: "Saved the original judge request before admission.",
          data: assessment.judgeRequest,
        });
      }
      this.db.append({
        runId: run.id,
        attemptId: input.attemptId,
        type: "judge.started",
        message: "Independent judge started.",
      });
      assessment.judgeAdmitted = true;
      const { invocation, ...verdict } = await this.runtime.judge({
        evidence: requestEvidence,
        configuration: input.configuration,
        artifactDirectory: input.artifactDirectory,
        timeoutMs,
        signal: input.signal,
      });
      // Preserve provider-owned usage and response even if a runtime violates its verdict contract.
      assessment.judgeUsage = invocation?.usage ?? verdict.usage;
      assessment.judgeResponse = jsonSchema.parse(invocation ?? verdict);
      assessment.judge = judgeVerdictSchema.parse(verdict);
    } catch (error) {
      const invocation = judgeInvocationSchema.safeParse(
        error && typeof error === "object" && "invocation" in error
          ? error.invocation
          : undefined,
      );
      if (invocation.success) {
        assessment.judgeResponse = jsonSchema.parse(invocation.data);
        assessment.judgeUsage = invocation.data.usage;
      }
      assessment.judgeError = errorMessage(error);
    }
    return assessment;
  }
}
