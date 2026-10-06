import { RunTools } from "./run-tools.js";
import { JevConfiguration } from "./jev-configuration.js";
import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EvaluationSettings } from "./evaluation-settings.js";
import { AgentSettings } from "./agent-settings.js";
import { initialSetup } from "./drafts.js";

it("keeps evidence requirements with the enabled judge and advanced limits collapsed", () => {
  const html = renderToStaticMarkup(
    <EvaluationSettings
      draft={{ ...initialSetup(), judge: true }}
      set={() => {}}
      setDraft={() => {}}
      evaluatorRevisions={[]}
      connections={[]}
      refreshBank={() => {}}
    />,
  );
  expect(html.indexOf("Repetitions")).toBeLessThan(
    html.indexOf("Judge evidence requirements"),
  );
  expect(html.indexOf("Add an LLM judge")).toBeLessThan(
    html.indexOf("Judge evidence requirements"),
  );
  expect(html).toContain("Advanced execution limits</summary>");
  expect(html).not.toContain("<details open");
});
it("explains agent turn limits beside advanced model settings", () => {
  const html = renderToStaticMarkup(
    <AgentSettings draft={initialSetup()} set={() => {}} connections={[]} />,
  );
  expect(html).toContain("Maximum agent steps within one question");
  expect(html).toContain("not the number of questions");
});

it("links connection management to Settings while preserving setup drafts", () => {
  const tools = renderToStaticMarkup(
    <RunTools
      draft={initialSetup()}
      set={() => {}}
      workspace={{ connections: [] }}
      discoveredTools={[]}
      discoveringTools={false}
      discoverTools={async () => {}}
    />,
  );
  const jev = renderToStaticMarkup(
    <JevConfiguration
      value={initialSetup().jevSelection}
      onChange={() => {}}
      connections={[]}
      onPublished={() => {}}
    />,
  );
  expect(tools).toContain('href="#/settings/connections"');
  expect(jev).toContain('href="#/settings/connections"');
  expect(tools).not.toContain("Add Tableau connection</button>");
  expect(jev).not.toContain("Add Jev connection</button>");
});
