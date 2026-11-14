import type { RunPerformance, UsageReport } from "../contracts.js";
import { uncachedInput, UsageProjection } from "./usage-projection.js";
import { AnswerSources } from "./answer-sources.js";
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
  const run = db.runState(runId);
  const answers = new AnswerSources(db);
  const physical = answers.physicalAttempts(runId);
  const sourceRuns = [...new Set(physical.values())];
  const ownAttempts = projection?.attempts(runId) ?? db.attemptSummaries(runId);
  const attempts = [
    ...ownAttempts,
    ...sourceRuns
      .filter((sourceRunId) => sourceRunId !== runId)
      .flatMap(
        (sourceRunId) =>
          projection?.attempts(sourceRunId) ?? db.attemptSummaries(sourceRunId),
      )
      .filter((attempt) => physical.has(attempt.id)),
  ];
  const results = answers.results(runId);
  const firstAttempts = new Map(
    ownAttempts
      .filter((attempt) => (attempt.executionId ?? run.id) === run.id)
      .map((attempt) => [attempt.resultId, attempt]),
  );
  const originalFailures = new Set(
    results
      .filter((result) => firstAttempts.get(result.id)?.status === "failed")
      .map((result) => result.id),
  );
  const latencies = attempts
    .filter((a) => a.status === "completed" && a.finishedAt)
    .map((a) => Date.parse(a.finishedAt!) - Date.parse(a.startedAt));
  const durationIncomplete =
    run.activeDurationIncomplete === true || run.activeDurationMs === undefined;
  const activeSegment = run.execution?.activeSegmentStartedAt;
  const durationMs = durationIncomplete
    ? null
    : run.activeDurationMs! +
      (activeSegment ? Math.max(0, Date.now() - Date.parse(activeSegment)) : 0);
  const events = db.eventCounts(runId);
  for (const sourceRunId of sourceRuns.filter((value) => value !== runId)) {
    const counts = db.eventCounts(
      sourceRunId,
      [...physical]
        .filter(([, owner]) => owner === sourceRunId)
        .map(([attemptId]) => attemptId),
    );
    for (const [type, count] of Object.entries(counts))
      events[type] = (events[type] ?? 0) + count;
  }
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
  let researcherInterrupted = false;
  let previousConversation: Usage;
  let seenConversation = false;
  for (const turn of parent?.reports ?? []) {
    const belongs = turn.runId === runId;
    if (turn.state !== "accepted") {
      if (belongs) {
        researcherUsage.push(turn.state === "pending" ? { pending: true } : {});
        if (turn.state === "pending") researcherTurns++;
        else researcherInterrupted = true;
      }
      continue;
    }
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
  const originalJudges = [
    ...db.originalJudgeUsage(runId),
    ...sourceRuns
      .filter((owner) => owner !== runId)
      .flatMap((owner) =>
        db.originalJudgeUsage(
          owner,
          [...physical]
            .filter(([, runOwner]) => runOwner === owner)
            .map(([attemptId]) => attemptId),
        ),
      ),
  ];
  const jev = sourceRuns
    .flatMap((owner) => db.jevSummaries(owner))
    .filter((assessment) => physical.has(assessment.attemptId))
    .flatMap((a) =>
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
      db
        .passJudgeUsage(runId)
        .filter((report) => !report.judgmentId.startsWith("original_llm_"))
        .map((report) => [report.judgmentId, report]),
    ).values(),
  ];
  const judgeUsage = [...originalJudges, ...jev, ...llm];
  return {
    durationMs,
    durationIncomplete,
    answerLatencyMs: {
      average: latencies.length
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length
        : null,
      minimum: latencies.length ? Math.min(...latencies) : null,
      maximum: latencies.length ? Math.max(...latencies) : null,
    },
    attempts: attempts.length,
    retries: attempts.filter((a) => a.number > 1 || a.runId !== runId).length,
    answered: results.filter((r) => r.answerSource).length,
    failures: results.filter((r) => r.status === "failed" && !r.answerSource)
      .length,
    recoveredResults: results.filter(
      (r) => r.answerSource && originalFailures.has(r.id),
    ).length,
    originalFailures: originalFailures.size,
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
    researcher:
      parent && !parent.attributionKnown
        ? {
            inputTokens: null,
            uncachedInputTokens: null,
            outputTokens: null,
            cachedInputTokens: null,
            costUsd: null,
            turns: null,
          }
        : {
            ...aggregateUsage(researcherUsage),
            turns: researcherInterrupted ? null : researcherTurns,
          },
    judge: { ...aggregateUsage(judgeUsage), calls: judgeUsage.length },
  };
}
