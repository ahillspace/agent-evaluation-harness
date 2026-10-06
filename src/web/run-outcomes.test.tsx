import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RunOutcomes } from "./run-outcomes.js";

it("shows execution failures separately from answered questions", () => {
  const html = renderToStaticMarkup(
    <RunOutcomes completed={17} total={20} failed={3} />,
  );
  expect(html).toContain("17 / 20 answered");
  expect(html).toContain("3 execution failures");
  expect(html).not.toContain("unanswered");
});
it("does not label pending or interrupted questions as execution failures", () => {
  const html = renderToStaticMarkup(
    <RunOutcomes completed={1} total={20} failed={1} />,
  );
  expect(html).toContain("1 execution failure");
  expect(html).toContain("18 unanswered");
});
