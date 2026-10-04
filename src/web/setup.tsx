import { ExternalAgentPicker } from "./external-agents.js";
import { useEffect, useState } from "react";
import { researchSchema } from "../contracts.js";
import type { RuntimeCatalog, WorkspaceView } from "../contracts.js";
import { command, navigate, useResource } from "./api.js";
import {
  createLaunch,
  objectJson,
  initialSetup,
  restoreSetup,
  type SetupDraft,
} from "./drafts.js";
import { parseToolCatalog, type ToolChoice } from "./tools.js";

import { AgentSettings } from "./agent-settings.js";
import { EvaluationSettings } from "./evaluation-settings.js";
import { RunQuestions } from "./run-questions.js";
import { RunTools } from "./run-tools.js";
import { ResearchSettings } from "./research-settings.js";
import { Empty, ErrorNotice, Field, Help, Icon, PageHeading } from "./ui.js";

const sections = [
  ["agent", "Agent under test", "Choose what to evaluate"],
  ["questions", "Questions", "Choose the evaluation basis"],
  ["tools", "Tools", "Define available capabilities"],
  ["evaluation", "Evaluation", "Repeats, limits, and judging"],
  ["research", "Research", "Optional agent improvements"],
] as const;
const researchOptions = researchSchema
  .pick({
    allowedChanges: true,
    searchSpace: true,
    objectiveMode: true,
    objectiveMetrics: true,
  })
  .strict();
export function Setup({
  workspace,
  refresh,
  sourceRunId,
  blueprintId,
}: {
  workspace: WorkspaceView;
  refresh: () => void;
  sourceRunId?: string;
  blueprintId?: string;
}) {
  const [draft, setDraft] = useState<SetupDraft>(initialSetup);
  const [section, setSection] = useState<string>("agent");
  const [runtime, setRuntime] = useState<RuntimeCatalog | undefined>(
    workspace.runtime,
  );
  const [discoveredTools, setDiscoveredTools] = useState<ToolChoice[]>([]);
  const [discoveringTools, setDiscoveringTools] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [loadingSource, setLoadingSource] = useState(!!sourceRunId);
  const set = <K extends keyof SetupDraft>(key: K, value: SetupDraft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  const discoverTools = async () => {
    setDiscoveringTools(true);
    setError(null);
    try {
      const response = await command("connections.test", {
        connectionId: draft.connectionId,
      });
      if (!response.ok) throw new Error(response.message);
      const tools = parseToolCatalog(response.tools);
      setDiscoveredTools(tools);
      if (!tools.length)
        throw new Error(
          "The connection returned no tools. Inspect connection discovery in Settings.",
        );
    } catch (cause) {
      setError(cause);
    } finally {
      setDiscoveringTools(false);
    }
  };
  useEffect(() => {
    if (draft.judge)
      void command("runtime.discover", {}).then(setRuntime).catch(setError);
  }, [draft.judge]);
  useEffect(() => {
    if (sourceRunId)
      void command("runs.get", { runId: sourceRunId })
        .then((value) => setDraft(restoreSetup(value.run)))
        .catch(setError)
        .finally(() => setLoadingSource(false));
    else if (blueprintId) {
      const blueprint = workspace.blueprints.find(
        (item) => item.id === blueprintId,
      );
      if (blueprint) setDraft(restoreSetup(blueprint));
    }
  }, [sourceRunId, blueprintId]);
  const selectedBankId =
    draft.bankId ||
    workspace.banks.find(
      (item) => item.latestRevisionId === draft.bankRevisionId,
    )?.id ||
    "";
  const detail = useResource(
    "banks.get",
    { bankId: selectedBankId },
    undefined,
    !!selectedBankId,
  );
  const bank = detail.data?.revisions.find(
    (item) => item.id === draft.bankRevisionId,
  );
  const bankRecord = workspace.banks.find((item) => item.id === selectedBankId);
  const published = workspace.banks.map((item) => ({
    id: item.latestRevisionId,
    name: item.name,
    number: item.latestRevisionNumber,
    count: item.questionCount,
  }));
  if (bank && !published.some((item) => item.id === bank.id))
    published.push({
      id: bank.id,
      name: bank.name,
      number: bank.number,
      count: bank.questions.length,
    });
  const launch = async () => {
    setPending(true);
    setError(null);
    try {
      const input = {
        ...createLaunch(draft),
        idempotencyKey: crypto.randomUUID(),
      };
      if (draft.research && draft.targetKind === "managed") {
        const result = await command("research.launch", {
          ...researchOptions.parse(objectJson(draft.researchSettings)),
          name: draft.name,
          baseline: input,
          researcher: {
            harness: draft.researcherHarness,
            model: draft.researcherModel,
            systemPrompt: draft.researcherPrompt,
            settings: objectJson(draft.researcherSettings),
            tools: [],
            connections: draft.researcherProviderConnectionId
              ? [
                  {
                    connectionId: draft.researcherProviderConnectionId,
                    provider: draft.researcherProviderConnectionProvider,
                    settings: {},
                    credentialFields: [],
                  },
                ]
              : [],
          },
          objective: draft.objective,
          guidance: draft.guidance,
          maxCandidates: draft.maxCandidates,
          maxDurationMs: draft.maxMinutes * 60_000,
          maxTargetInvocations: draft.maxTargetInvocations,
          maxResearcherTurns: draft.maxResearcherTurns,
          maxTotalTokens: draft.maxTotalTokens.trim()
            ? Number(draft.maxTotalTokens)
            : undefined,
          maxCostUsd: draft.maxCostUsd.trim()
            ? Number(draft.maxCostUsd)
            : undefined,
          idempotencyKey: input.idempotencyKey,
        });
        navigate(
          `/observe/${result.session.currentRunId}?session=${result.session.id}`,
        );
      } else {
        const result = await command("runs.launch", input);
        navigate(`/observe/${result.run.id}`);
      }
      refresh();
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  };
  if (loadingSource)
    return <div className="loading">Loading frozen run configuration...</div>;
  return (
    <>
      <PageHeading
        eyebrow="Run / Setup"
        title="Design your next evaluation"
        description="One agent configuration. A fixed question set. Evidence you can inspect."
      />
      <ErrorNotice error={error} />
      {!workspace.banks.length ? (
        <Empty
          title="Create a question bank first"
          action={
            <a className="button primary" href="#/banks">
              Open question banks
              <Icon name="arrow" />
            </a>
          }
        >
          A bank provides the questions and expected answers for a repeatable
          evaluation.
        </Empty>
      ) : (
        <div className="setup-layout">
          <nav className="setup-nav" aria-label="Run setup sections">
            {sections
              .filter(
                ([id]) =>
                  draft.targetKind === "managed" ||
                  !["tools", "research"].includes(id),
              )
              .map(([id, label, description], index) => (
                <button
                  key={id}
                  className={section === id ? "active" : ""}
                  onClick={() => setSection(id)}
                >
                  <span className="step-number">{index + 1}</span>
                  <span>
                    <strong>{label}</strong>
                    <small>{description}</small>
                  </span>
                  {["agent", "questions"].includes(id) && (
                    <span title="Required section">*</span>
                  )}
                </button>
              ))}
            <div className="setup-note">
              <Icon name="shield" />
              <p>
                Starting a run freezes the agent, questions, and evaluator.
                Saved evidence stays inspectable.
              </p>
            </div>
          </nav>
          <section className="panel setup-main">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">
                  {section === "research" ? "Optional" : "Configuration"}
                </span>
                <h2>{sections.find(([id]) => id === section)?.[1]}</h2>
              </div>
              <Help
                label={sections.find(([id]) => id === section)?.[1] ?? "Setup"}
              >
                {
                  {
                    questions:
                      "Choose a published bank revision and the questions to evaluate. Expected answers stay private to the evaluator.",
                    agent:
                      "Select your harness and model, then define the instructions that every question receives.",
                    tools:
                      "Only selected tools are available to the target. Tool access and connection bindings are frozen into the run.",
                    evaluation:
                      "Repetitions evaluate every selected question again. Deterministic grading always runs. Optional judging remains a separate assessment.",
                    research:
                      "A persistent researcher evaluates a baseline, proposes ordinary agent configurations, and compares their runs. Candidate count and time bound this work.",
                  }[section]
                }
              </Help>
            </div>
            <div className="panel-body stack">
              {section === "questions" && (
                <RunQuestions
                  draft={draft}
                  set={set}
                  setDraft={setDraft}
                  bank={bank}
                  published={published}
                  workspace={workspace}
                />
              )}
              {section === "agent" && (
                <>
                  {draft.targetKind === "managed" && (
                    <button
                      className="button"
                      onClick={() => {
                        void command("runtime.discover", {})
                          .then(setRuntime)
                          .catch(setError);
                      }}
                    >
                      Discover installed harnesses and models
                    </button>
                  )}
                  <Field label="Agent ownership">
                    <select
                      aria-label="Agent ownership"
                      value={draft.targetKind}
                      onChange={(event) =>
                        setDraft((value) => ({
                          ...value,
                          targetKind: event.target.value as
                            "managed" | "external",
                          research: false,
                          timeoutSeconds:
                            event.target.value === "external" ? 120 : 300,
                        }))
                      }
                    >
                      <option value="managed">Configure an agent</option>
                      <option value="external">Use an external agent</option>
                    </select>
                  </Field>
                  {draft.targetKind === "external" ? (
                    <ExternalAgentPicker
                      target={draft.externalTarget}
                      onChange={(target) => set("externalTarget", target)}
                    />
                  ) : (
                    <AgentSettings
                      draft={draft}
                      set={set}
                      catalog={runtime}
                      connections={workspace.connections}
                    />
                  )}
                </>
              )}
              {section === "tools" && draft.targetKind === "managed" && (
                <RunTools
                  workspace={workspace}
                  draft={draft}
                  set={set}
                  discoveredTools={discoveredTools}
                  discoveringTools={discoveringTools}
                  discoverTools={discoverTools}
                />
              )}
              {section === "evaluation" && (
                <EvaluationSettings
                  bankDetail={detail.data ?? undefined}
                  refreshBank={detail.refresh}
                  draft={draft}
                  set={set}
                  setDraft={setDraft}
                  catalog={runtime}
                  bankRecord={bankRecord}
                  evaluatorRevisions={detail.data?.evaluatorRevisions ?? []}
                  connections={workspace.connections}
                />
              )}
              {section === "research" && (
                <ResearchSettings
                  draft={draft}
                  set={set}
                  setDraft={setDraft}
                  catalog={runtime}
                  connections={workspace.connections}
                />
              )}
            </div>
            <footer className="setup-footer">
              <span>
                {bank
                  ? `${draft.questionIds.length || bank.questions.length} questions × ${draft.repetitions} repetitions`
                  : "Choose a question bank"}
              </span>
              <button
                className="button primary"
                disabled={
                  pending ||
                  !bank ||
                  (draft.targetKind === "external"
                    ? !draft.externalTarget
                    : !draft.model.trim())
                }
                onClick={() => {
                  void launch();
                }}
              >
                <Icon name="run" size={16} />
                {pending
                  ? "Starting..."
                  : draft.research
                    ? "Start research"
                    : "Start run"}
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
