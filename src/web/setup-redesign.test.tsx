import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ResearchSettings } from "./research-settings.js";
import { RunQuestions } from "./run-questions.js";
import { EvaluatorPolicy } from "./evaluator-policy.js";
import { initialSetup } from "./drafts.js";
import { evaluatorSettingsSchema, type BankRevision } from "../contracts.js";

it("offers one research instruction field, an explicit selection metric, and early stopping controls", () => {
  const html = renderToStaticMarkup(
    <ResearchSettings
      draft={{ ...initialSetup(), research: true }}
      set={() => {}}
      setDraft={() => {}}
      connections={[]}
    />,
  );
  expect(html).toContain("Allow researcher to stop early");
  expect(html).toContain("Selection metric");
  expect(html).not.toContain('aria-label="Research guidance"');
  expect(html).not.toContain('aria-label="Research objective"');
});
it("preserves explicit question selection and exposes searchable expected-answer size filters", () => {
  const bank = {
    questions: [
      { id: "q", text: "Question", expected: "x".repeat(9000), tags: [] },
    ],
  } as unknown as BankRevision;
  const html = renderToStaticMarkup(
    <RunQuestions
      bankState="ready"
      retryBank={() => {}}
      draft={initialSetup()}
      set={() => {}}
      setDraft={() => {}}
      bank={bank}
      published={[]}
      workspace={{ banks: [], connections: [] }}
    />,
  );
  expect(html).toContain("Deselect all");
  expect(html).toContain("Minimum expected answer tokens");
  expect(html).toContain("Maximum expected answer tokens");
  expect(html).toContain("Large expected answer");
});
it("makes representation, duplicate grain, and collation configurable without requiring them", () => {
  const html = renderToStaticMarkup(
    <EvaluatorPolicy
      settings={evaluatorSettingsSchema.parse({})}
      onChange={() => {}}
    />,
  );
  expect(html).toContain("Answer representation");
  expect(html).toContain("Duplicate rows");
  expect(html).toContain("Collation");
});
