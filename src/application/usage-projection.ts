import type { AttemptSummary, RuntimePort, UsageReport } from "../contracts.js";
import { Database } from "../storage/database.js";

export function uncachedInput(usage: UsageReport["usage"]): number | undefined {
  const input = usage?.inputTokens,
    cache = usage?.cachedInputTokens;
  return typeof input === "number" &&
    Number.isSafeInteger(input) &&
    input >= 0 &&
    typeof cache === "number" &&
    Number.isSafeInteger(cache) &&
    cache >= 0 &&
    cache <= input
    ? input - cache
    : undefined;
}

/** Recover missing breakdowns from small provider usage events without changing sealed evidence. */
export class UsageProjection {
  private readonly settled = new Map<string, UsageReport["usage"]>();
  constructor(
    private readonly db: Database,
    private readonly normalize?: RuntimePort["normalizeRecordedUsage"],
  ) {}
  attempts(runId: string): AttemptSummary[] {
    const target = this.db.runState(runId);
    return this.db.attemptSummaries(runId).map((attempt) => {
      let usage = attempt.usage;
      if (
        usage &&
        usage.cachedInputTokens === undefined &&
        attempt.status !== "running" &&
        target.targetKind === "managed" &&
        target.targetHarness &&
        this.normalize
      ) {
        if (this.settled.has(attempt.id)) {
          usage = this.settled.get(attempt.id);
          this.settled.delete(attempt.id);
        } else {
          const events = this.db.attemptUsageEvents(attempt.id);
          const recovered =
            events && this.normalize(target.targetHarness, events);
          if (
            recovered &&
            recovered.inputTokens === usage.inputTokens &&
            recovered.outputTokens === usage.outputTokens &&
            uncachedInput(recovered) !== undefined
          )
            usage = {
              ...usage,
              cachedInputTokens: recovered.cachedInputTokens,
            };
        }
        this.settled.set(attempt.id, usage);
        if (this.settled.size > 1000)
          this.settled.delete(this.settled.keys().next().value!);
      }
      const uncached = uncachedInput(usage);
      return {
        ...attempt,
        ...(usage
          ? {
              usage: {
                ...usage,
                ...(uncached === undefined
                  ? {}
                  : { uncachedInputTokens: uncached }),
              },
            }
          : {}),
      };
    });
  }
}
