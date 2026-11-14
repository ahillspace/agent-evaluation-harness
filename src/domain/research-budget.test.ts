import { describe, expect, it } from "vitest";
import {
  researchSchema,
  type AttemptRecord,
  type ResearchRecord,
} from "../contracts.js";
import { researchBudgetReason } from "./research-budget.js";
import { researchTurnAccounting } from "./research-turns.js";

function accounting(value: ResearchRecord) {
  return researchTurnAccounting({
    admitted: value.researcherInvocations,
    completed: value.turns.length,
    pending: !!value.pendingTurn,
    recordedInterrupted: value.interruptedTurns,
    history:
      value.turns.length > 0 ||
      !!value.pendingTurn ||
      (value.interruptedTurns ?? 0) > 0,
  });
}

const agent = { harness: "codex", model: "model" };
function session(): ResearchRecord {
  const configuration = researchSchema.parse({
    baseline: { bankRevisionId: "bank", agent },
    researcher: agent,
    objective: "Improve accuracy",
    maxTotalTokens: 100,
  });
  return {
    id: "research",
    name: "Research",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
    intent: "run",
    configuration,
    baselineRunId: "run",
    currentRunId: "run",
    bestRunId: "run",
    runIds: ["run"],
    phase: "researching",
    turns: [],
  };
}
const attempt: AttemptRecord = {
  id: "attempt",
  resultId: "result",
  runId: "run",
  number: 1,
  startedAt: new Date().toISOString(),
  status: "completed",
  output: {
    answer: 1,
    text: "1",
    usage: { inputTokens: 10, outputTokens: 10 },
  },
};
describe("research admission budgets", () => {
  it("uses admitted turns rather than historical recorded counters for unknown spending", () => {
    const value = session();
    value.researcherInvocations = 0;
    value.interruptedTurns = 99;
    expect(
      researchBudgetReason(value, [attempt], accounting(value)),
    ).toBeUndefined();
    value.researcherInvocations = 1;
    value.interruptedTurns = 0;
    expect(researchBudgetReason(value, [attempt], accounting(value))).toContain(
      "interrupted researcher",
    );
  });
  it("counts cumulative researcher usage once and includes independent judge usage", () => {
    const value = session();
    value.turns = [30, 60].map((tokens) => ({
      input: "{}",
      createdAt: value.createdAt,
      output: {
        conversationId: "same",
        message: "Next",
        usageScope: "conversation",
        usage: { inputTokens: tokens, outputTokens: 0 },
      },
    }));
    value.researcherInvocations = value.turns.length;
    expect(
      researchBudgetReason(value, [attempt], accounting(value)),
    ).toBeUndefined();
    expect(
      researchBudgetReason(value, [attempt], accounting(value), 0, Date.now(), [
        { inputTokens: 20, outputTokens: 0 },
      ]),
    ).toContain("Token budget");
  });
  it("rejects unknown spending and reserves each physical attempt", () => {
    const value = session();
    value.configuration.maxTargetInvocations = 1;
    expect(
      researchBudgetReason(value, [attempt], accounting(value), 1),
    ).toContain("invocation budget");
    expect(
      researchBudgetReason(value, [attempt], accounting(value), 0, Date.now(), [
        undefined,
      ]),
    ).toContain("unavailable");
    value.interruptedTurns = 1;
    expect(researchBudgetReason(value, [attempt], accounting(value))).toContain(
      "admission history",
    );
  });
});
