import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { BankFindings } from "./bank-findings.js";

vi.mock("./api.js", () => ({
  command: vi.fn(),
  useResource: () => ({
    data: [
      {
        id: "finding-1",
        bankId: "bank-1",
        questionId: "q1",
        title: "Possible rounding issue",
        kind: "reference",
        status: "open",
        note: "The submitted answer has the requested precision.",
        createdAt: "2026-10-12T00:00:00Z",
        runId: "run-1",
        resultId: "result-1",
      },
    ],
    error: null,
    refresh: vi.fn(),
  }),
}));

it("keeps findings reviewable without showing every resolution form upfront", () => {
  const html = renderToStaticMarkup(
    <BankFindings
      bankId="bank-1"
      onSaved={() => {}}
      onEditQuestion={() => {}}
    />,
  );
  expect(html).toContain("Possible rounding issue");
  expect(html).toContain("Review finding");
  expect(html).toContain("Edit question rules");
  expect(html).toContain("View source answer");
  expect(html).toContain("#/observe/run-1?result=result-1");
  expect(html).not.toContain("<details open");
  expect(html).toContain("About Findings");
});
