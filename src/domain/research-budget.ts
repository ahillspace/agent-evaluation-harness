import type {
  AttemptRecord,
  ResearchRecord,
  TargetOutput,
} from "../contracts.js";

export function researchBudgetReason(
  session: ResearchRecord,
  attempts: AttemptRecord[],
  additionalTargets = 0,
  timestamp = Date.now(),
  additionalUsage: Array<TargetOutput["usage"]> = [],
): string | undefined {
  const config = session.configuration;
  if (
    (session.interruptedTurns ?? 0) > 0 &&
    (config.maxTotalTokens !== undefined || config.maxCostUsd !== undefined)
  )
    return "An interrupted researcher turn has unknown usage; the configured spending budget cannot be enforced.";
  if (timestamp - Date.parse(session.createdAt) >= config.maxDurationMs)
    return "Research duration budget reached.";
  if (attempts.length + additionalTargets > config.maxTargetInvocations)
    return "Target invocation budget reached.";
  const settled = attempts.filter((attempt) => attempt.status !== "running");
  const turnUsage = session.turns
    .filter((turn) => turn.output.usageScope !== "conversation")
    .map((turn) => turn.output.usage);
  const conversationUsage = session.turns
    .filter((turn) => turn.output.usageScope === "conversation")
    .at(-1)?.output.usage;
  const usage = [
    ...settled.map(
      (attempt) =>
        attempt.output?.usage ?? attempt.failure?.classification?.usage,
    ),
    ...turnUsage,
    ...(session.turns.some((turn) => turn.output.usageScope === "conversation")
      ? [conversationUsage]
      : []),
    ...additionalUsage,
  ];
  if (config.maxTotalTokens !== undefined) {
    if (
      usage.some(
        (value) =>
          value?.inputTokens === undefined || value.outputTokens === undefined,
      )
    )
      return "Token usage is unavailable; the configured token budget cannot be enforced.";
    if (
      usage.reduce(
        (sum, value) =>
          sum + (value?.inputTokens ?? 0) + (value?.outputTokens ?? 0),
        0,
      ) >= config.maxTotalTokens
    )
      return "Token budget reached.";
  }
  if (config.maxCostUsd !== undefined) {
    if (usage.some((value) => value?.costUsd === undefined))
      return "Cost usage is unavailable; the configured cost budget cannot be enforced.";
    if (
      usage.reduce((sum, value) => sum + (value?.costUsd ?? 0), 0) >=
      config.maxCostUsd
    )
      return "Cost budget reached.";
  }
  return undefined;
}
