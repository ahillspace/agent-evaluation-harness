import { expect, it } from "vitest";
import { evaluatorSettingsSchema } from "../contracts.js";
import { questionRuleSummary } from "./bank-questions.js";

it("summarizes the selected comparison without unrelated numeric or table rules", () => {
  const settings = evaluatorSettingsSchema.parse({
    questionOverrides: { text: { mode: "text" }, numeric: { mode: "numeric" } },
  });
  expect(questionRuleSummary(settings, "text")).not.toMatch(/Numeric|Tables/);
  expect(questionRuleSummary(settings, "numeric")).not.toMatch(/text|Tables/);
});
