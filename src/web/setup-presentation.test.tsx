import { RunTools } from "./run-tools.js";
import { JevConfiguration } from "./jev-configuration.js";
import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EvaluationSettings } from "./evaluation-settings.js";
import { AgentSettings } from "./agent-settings.js";
import { initialSetup } from "./drafts.js";
import type { BankDetail, ConnectionRecord } from "../contracts.js";
import { jevConfigurationIssues } from "./jev-configuration.js";

it("keeps evidence requirements with the enabled judge and advanced limits collapsed", () => {
  const html = renderToStaticMarkup(
    <EvaluationSettings
      draft={{ ...initialSetup(), judge: true }}
      set={() => {}}
      setDraft={() => {}}
      evaluatorRevisions={[]}
      connections={[]}
      refreshBank={() => {}}
      onJevProfilePublished={() => {}}
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

it("distinguishes the saved Jev API connection from bank judging criteria", () => {
  const connection: ConnectionRecord = {
    id: "jev-key",
    name: "Jev",
    provider: "typesafe",
    settings: {},
    credentialFields: [],
    hasCredentials: true,
  };
  const bank = {
    bank: { id: "bank-a", activeJevProfileRevisionId: undefined },
    jevProfiles: [],
  } as unknown as BankDetail;
  const html = renderToStaticMarkup(
    <JevConfiguration
      value={{ ...initialSetup().jevSelection, connectionId: "jev-key" }}
      onChange={() => {}}
      connections={[connection]}
      bank={bank}
      onPublished={() => {}}
    />,
  );

  expect(html).toContain('aria-label="Jev API connection"');
  expect(html).toContain(
    "The saved API key provides access to Jev. Judging criteria are published separately for each question bank.",
  );
  expect(html).toContain(
    "This question bank has no published Jev judging profile.",
  );
  expect(html).toContain("Publish criteria for this bank</button>");
  expect(
    jevConfigurationIssues(
      { ...initialSetup().jevSelection, connectionId: connection.id },
      [connection],
      bank,
    ).profile,
  ).toContain("This question bank has no published Jev judging profile.");

  const publishedBank = {
    ...bank,
    bank: { ...bank.bank, activeJevProfileRevisionId: "profile-a" },
    jevProfiles: [{ id: "profile-a", bankId: "bank-a" }],
  } as unknown as BankDetail;
  expect(
    jevConfigurationIssues(
      { ...initialSetup().jevSelection, connectionId: connection.id },
      [connection],
      publishedBank,
    ),
  ).toEqual({ connection: undefined, profile: undefined });

  const locallyPublishedProfile = {
    id: "profile-local",
    bankId: "bank-a",
  } as unknown as BankDetail["jevProfiles"][number];
  expect(
    jevConfigurationIssues(
      {
        ...initialSetup().jevSelection,
        connectionId: connection.id,
        profileRevisionId: locallyPublishedProfile.id,
      },
      [connection],
      bank,
      [locallyPublishedProfile],
    ),
  ).toEqual({ connection: undefined, profile: undefined });

  const otherBank = {
    bank: { id: "bank-b", activeJevProfileRevisionId: undefined },
    jevProfiles: [],
  } as unknown as BankDetail;
  expect(
    jevConfigurationIssues(
      {
        ...initialSetup().jevSelection,
        connectionId: connection.id,
        profileRevisionId: locallyPublishedProfile.id,
      },
      [connection],
      otherBank,
      [locallyPublishedProfile],
    ).profile,
  ).toContain("no published Jev judging profile");
});
