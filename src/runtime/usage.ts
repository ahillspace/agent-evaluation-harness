import type { TargetOutput } from "../contracts.js";
import { record } from "./harness.js";

type KnownUsage = {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
};
const tokens = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function normalizeHarnessUsage(
  harness: string,
  data: unknown,
): KnownUsage | undefined {
  if (!record(data)) return undefined;
  let inputTokens: number;
  let outputTokens: number;
  if (harness === "opencode") {
    const usage = data.tokens;
    if (
      !record(usage) ||
      !record(usage.cache) ||
      !tokens(usage.input) ||
      !tokens(usage.output) ||
      !tokens(usage.reasoning) ||
      !tokens(usage.cache.read) ||
      !tokens(usage.cache.write)
    )
      return undefined;
    // OpenCode 1.18.32 Session.getUsage subtracts cache from input and reasoning
    // from output. Restore each disjoint component exactly once.
    // https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/session/session.ts
    inputTokens = usage.input + usage.cache.read + usage.cache.write;
    outputTokens = usage.output + usage.reasoning;
    if (
      usage.total !== undefined &&
      (!tokens(usage.total) || usage.total !== inputTokens + outputTokens)
    )
      return undefined;
  } else if (harness === "codex") {
    if (!tokens(data.input_tokens) || !tokens(data.output_tokens))
      return undefined;
    // Codex reports inclusive input/output counts; cache and reasoning are subsets.
    inputTokens = data.input_tokens;
    outputTokens = data.output_tokens;
  } else return undefined;
  if (!tokens(inputTokens + outputTokens)) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(typeof data.cost === "number" &&
    Number.isFinite(data.cost) &&
    data.cost >= 0
      ? { costUsd: data.cost }
      : {}),
  };
}

/** Aggregate provider steps without hiding incomplete reports or counting duplicate IDs. */
export class HarnessUsage {
  private readonly seen = new Map<string, string>();
  private observed = false;
  private unknown = false;
  private unknownCost = false;
  private inputTokens = 0;
  private outputTokens = 0;
  private costUsd = 0;
  constructor(private readonly harness: string) {}

  add(data: unknown): void {
    if (
      this.harness === "opencode" &&
      record(data) &&
      typeof data.id === "string"
    ) {
      const fingerprint = JSON.stringify({
        tokens: data.tokens,
        cost: data.cost,
      });
      const previous = this.seen.get(data.id);
      if (previous !== undefined) {
        if (previous !== fingerprint) this.unknown = true;
        return;
      }
      this.seen.set(data.id, fingerprint);
    }
    const usage = normalizeHarnessUsage(this.harness, data);
    if (!usage) {
      this.unknown = true;
      return;
    }
    this.observed = true;
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    if (usage.costUsd === undefined) this.unknownCost = true;
    else this.costUsd += usage.costUsd;
  }

  value(): TargetOutput["usage"] {
    if (
      !this.observed ||
      this.unknown ||
      !tokens(this.inputTokens + this.outputTokens)
    )
      return undefined;
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      ...(!this.unknownCost && Number.isFinite(this.costUsd)
        ? { costUsd: this.costUsd }
        : {}),
    };
  }
}
