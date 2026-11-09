import type {
  BankRevision,
  EvaluatorRevision,
  FrozenJevJudge,
  JudgeConfig,
  Json,
} from "../contracts.js";

export type JudgmentStatus =
  "correct" | "incorrect" | "unjudged" | "error" | "excluded";
export interface PassJudgment {
  source?: { runId: string; resultId: string };
  judgmentId?: string;
  resultId: string;
  attemptId?: string;
  status: JudgmentStatus;
  explanation: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    costUsd?: number;
  };
  jevAssessmentId?: string;
  jevAssessmentStatus?: "pending" | "completed" | "error";
  request?: Json;
  response?: Json;
  evidenceHash?: string;
  details?: Json;
  error?: { code: string; message: string; httpStatus?: number };
  review?: {
    reviewer: string;
    note: string;
    previousStatus: JudgmentStatus;
    createdAt: string;
  };
}
export interface AssessmentCoverage {
  eligible: number;
  answered: number;
  judged: number;
  correct: number;
  incorrect: number;
  unjudged: number;
  errors: number;
  excluded: number;
  reviewed: number;
  overridden: number;
}
export interface AssessmentPass {
  retryApplicationId?: string;
  id: string;
  runId: string;
  name: string;
  source: "deterministic" | "llm" | "jev" | "human";
  status: "running" | "completed" | "interrupted";
  createdAt: string;
  finishedAt?: string;
  parentPassId?: string;
  basis: {
    bankRevisionId: string;
    evaluatorRevisionId: string;
    eligibleResultIds: string[];
    excludedResultIds: string[];
    referenceHash: string;
  };
  configuration: {
    evaluator?: EvaluatorRevision;
    referenceBank?: BankRevision;
    judge?: JudgeConfig;
    jevJudge?: FrozenJevJudge;
  };
  judgments: PassJudgment[];
  coverage: AssessmentCoverage;
  retryableJudgments?: number;
  retryUnavailableReason?: string;
  eligibleOutcome?: number | null;
  accuracy: number | null;
  judgedAccuracy: number | null;
}
export type AssessmentPassObservation = Omit<
  AssessmentPass,
  "configuration" | "judgments"
> & {
  judgments: Omit<PassJudgment, "request" | "response" | "details">[];
  observationRevision: string;
};
export type AssessmentPassDetail = AssessmentPass & {
  observationRevision: string;
};
export type AssessmentPassSummary = Omit<
  AssessmentPass,
  "configuration" | "judgments" | "basis"
> & {
  basis: Omit<
    AssessmentPass["basis"],
    "eligibleResultIds" | "excludedResultIds"
  >;
};
export interface UsageReport {
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    costUsd?: number;
  };
  pending?: boolean;
}
export interface UsageReporting {
  uncachedInputTokens?: { reported: number; missing: number; pending: number };
  inputTokens: { reported: number; missing: number; pending: number };
  outputTokens: { reported: number; missing: number; pending: number };
  cachedInputTokens: { reported: number; missing: number; pending: number };
  costUsd: { reported: number; missing: number; pending: number };
}
export interface UsageTotals {
  uncachedInputTokens?: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens?: number | null;
  costUsd: number | null;
  reporting?: UsageReporting;
}
export interface RunPerformance {
  recoveredResults?: number;
  originalFailures?: number;
  durationMs: number | null;
  answerLatencyMs: {
    average: number | null;
    minimum: number | null;
    maximum: number | null;
  };
  attempts: number;
  retries: number;
  answered: number;
  failures: number;
  target: UsageTotals & {
    turns: number | null;
    toolCalls: number | null;
  };
  researcher: UsageTotals & {
    turns: number | null;
  };
  judge: UsageTotals & {
    calls: number;
  };
}
export interface BankFinding {
  id: string;
  bankId: string;
  bankRevisionId: string;
  questionId: string;
  kind: "reference" | "ambiguity" | "duplicates" | "datasource";
  status: "open" | "accepted" | "dismissed";
  title: string;
  note: string;
  createdAt: string;
  runId?: string;
  resultId?: string;
  passId?: string;
  resolution?: {
    note: string;
    reviewer: string;
    createdAt: string;
    bankRevisionId?: string;
  };
}
