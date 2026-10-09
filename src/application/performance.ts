import type { RunPerformance, UsageReport } from "../contracts.js";
import { uncachedInput, UsageProjection } from "./usage-projection.js";
import { Database } from "../storage/database.js";

type Usage =
  | {
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      costUsd?: number;
    }
  | undefined;
export function aggregateUsage(reports: UsageReport[]) {
  const field = (
    key:
      | "inputTokens"
      | "outputTokens"
      | "cachedInputTokens"
      | "uncachedInputTokens"
      | "costUsd",
  ) => {
    let total = 0,
      reported = 0,
      missing = 0,
      pending = 0;
    for (const report of reports) {
      const value =
        key === "uncachedInputTokens"
          ? uncachedInput(report.usage)
          : report.usage?.[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        total += value;
        reported++;
      } else if (report.pending) pending++;
      else missing++;
    }
    return {
      value: reported || reports.length === 0 ? total : null,
      coverage: { reported, missing, pending },
    };
  };
  const input = field("inputTokens"),
    uncached = field("uncachedInputTokens"),
    output = field("outputTokens"),
    cached = field("cachedInputTokens"),
    cost = field("costUsd");
  return {
    inputTokens: input.value,
    uncachedInputTokens: uncached.value,
    outputTokens: output.value,
    cachedInputTokens: cached.value,
    costUsd: cost.value,
    reporting: {
      inputTokens: input.coverage,
      uncachedInputTokens: uncached.coverage,
      outputTokens: output.coverage,
      cachedInputTokens: cached.coverage,
      costUsd: cost.coverage,
    },
  };
}
export function runPerformance(
  db: Database,
  runId: string,
  projection?: UsageProjection,
): RunPerformance {
  const run = db.require("run", runId);
  const attempts = projection?.attempts(runId) ?? db.attemptSummaries(runId);
  const results = db.list("result", { runId });
  const latencies = attempts
    .filter((a) => a.status === "completed" && a.finishedAt)
    .map((a) => Date.parse(a.finishedAt!) - Date.parse(a.startedAt));
  const start = attempts.length
    ? Math.min(...attempts.map((a) => Date.parse(a.startedAt)))
    : null;
  const settled = [
    "completed",
    "failed",
    "cancelled",
    "paused",
    "halted",
    "interrupted",
  ].includes(run.status);
  const end = settled ? Date.parse(run.updatedAt) : Date.now();
  const events = db.eventCounts(runId);
  const toolCalls = (events["tool.started"] ?? 0) + (events["tool.call"] ?? 0);
  const turns =
    (events["turn.started"] ?? 0) +
    (events["agent.turn"] ?? 0) +
    (events["usage"] ?? 0);
  const parent = run.researchSessionId
    ? db.researchUsage(run.researchSessionId)
    : undefined;
  const researcherUsage: UsageReport[] = [];
  let researcherTurns = 0;
  let previousConversation: Usage;
  let seenConversation = false;
  for (const turn of parent?.turns ?? []) {
    const belongs = turn.runId === runId;
    if (turn.runId === null) researcherUsage.push({});
    let value = turn.usage;
    if (turn.usageScope === "conversation") {
      const current = value;
      if (belongs) {
        const delta = (
          key: "inputTokens" | "outputTokens" | "cachedInputTokens" | "costUsd",
        ) =>
          current?.[key] === undefined ||
          (seenConversation && previousConversation?.[key] === undefined) ||
          (current?.[key] !== undefined &&
            previousConversation?.[key] !== undefined &&
            current[key]! < previousConversation[key]!)
            ? undefined
            : Math.max(0, current[key]! - (previousConversation?.[key] ?? 0));
        value = {
          inputTokens: delta("inputTokens"),
          outputTokens: delta("outputTokens"),
          cachedInputTokens: delta("cachedInputTokens"),
          costUsd: delta("costUsd"),
        };
      }
      previousConversation = current;
      seenConversation = true;
    }
    if (belongs) {
      researcherTurns++;
      researcherUsage.push({ usage: value });
    }
  }
  if (parent?.currentRunId === runId) {
    if (parent.pending) researcherUsage.push({ pending: true });
    for (let index = 0; index < parent.interruptedTurns; index++)
      researcherUsage.push({});
  }
  const originalJudges = db.originalJudgeUsage(runId);
  const jev = db.jevSummaries(runId).flatMap((a) =>
    a.fallbackApplied
      ? [
          {
            usage: a.fallbackUsage,
            pending: false,
          },
          {
            usage: a.fallbackResultUsage,
            pending: a.status === "pending",
          },
        ]
      : [{ usage: a.usage, pending: a.status === "pending" }],
  );
  const llm = [
    ...new Map(
      db.passJudgeUsage(runId).map((report) => [report.judgmentId, report]),
    ).values(),
  ];
  const judgeUsage = [...originalJudges, ...jev, ...llm];
  return {
    durationMs: start === null ? null : Math.max(0, end - start),
    answerLatencyMs: {
      average: latencies.length
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length
        : null,
      minimum: latencies.length ? Math.min(...latencies) : null,
      maximum: latencies.length ? Math.max(...latencies) : null,
    },
    attempts: attempts.length,
    retries: attempts.filter((a) => a.number > 1).length,
    answered: results.filter((r) => r.status === "completed").length,
    failures: results.filter((r) => r.status === "failed").length,
    target: {
      ...aggregateUsage(
        attempts.map((a) => ({
          usage: a.usage,
          pending: a.status === "running",
        })),
      ),
      turns: turns || null,
      toolCalls: toolCalls || null,
    },
    researcher: {
      ...aggregateUsage(researcherUsage),
      turns:
        parent &&
        ((parent.interruptedTurns > 0 && parent.currentRunId === runId) ||
          parent.turns.some((turn) => turn.runId === null))
          ? null
          : parent
            ? researcherTurns +
              (parent.pending && parent.currentRunId === runId ? 1 : 0)
            : 0,
    },
    judge: { ...aggregateUsage(judgeUsage), calls: judgeUsage.length },
  };
}
