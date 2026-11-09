import { ExternalAgentPicker } from "./external-agents.js";
import { useEffect, useRef, useState } from "react";
import { researchSchema } from "../contracts.js";
import type { RuntimeCatalog, WorkspaceView } from "../contracts.js";
import type { JevProfileRevision } from "../contracts.js";
import { command, CommandError, navigate, useResource } from "./api.js";
import {
  createLaunch,
  objectJson,
  roleSettings,
  initialSetup,
  type SetupDraft,
} from "./drafts.js";
import { parseToolCatalog, type ToolChoice } from "./tools.js";

import { AgentSettings } from "./agent-settings.js";
import { EvaluationSettings } from "./evaluation-settings.js";
import { jevConfigurationIssues } from "./jev-configuration.js";
import { RunQuestions } from "./run-questions.js";
import { RunTools } from "./run-tools.js";
import { ResearchSettings } from "./research-settings.js";
import { Empty, ErrorNotice, Field, Help, Icon, PageHeading } from "./ui.js";
import {
  setupDraftKey,
  decodeSetupDraft,
  encodeSetupDraft,
  selectedQuestionIds,
  pendingLaunchSchema,
  type PendingLaunch,
} from "./setup-draft.js";
import { useRoleCatalog } from "./setup-discovery.js";
import { hydrateSetupSource } from "./setup-source.js";

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
  const storageKey = setupDraftKey(workspace.workspaceId);
  const source = sourceRunId
    ? `run:${sourceRunId}`
    : blueprintId
      ? `blueprint:${blueprintId}`
      : "";
  const [saved] = useState(() => {
    try {
      return storageKey
        ? decodeSetupDraft(sessionStorage.getItem(storageKey))
        : undefined;
    } catch {
      return undefined;
    }
  });
  const restoreSaved =
    !!saved && (!!saved.pendingLaunch || !source || saved.source === source);
  const mounted = useRef(false);
  const acknowledged = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [pendingLaunch, setPendingLaunch] = useState<PendingLaunch | undefined>(
    () => (restoreSaved ? saved?.pendingLaunch : undefined),
  );
  const [draft, setDraft] = useState<SetupDraft>(() =>
    restoreSaved ? saved!.draft : initialSetup(),
  );
  const [section, setSection] = useState<string>(() =>
    restoreSaved ? saved!.section : "agent",
  );
  const [draftSource, setDraftSource] = useState(
    restoreSaved ? saved!.source : source,
  );
  const [draftReady, setDraftReady] = useState(!source || restoreSaved);
  const [storageError, setStorageError] = useState<unknown>(null);
  const [runtime, setRuntime] = useState<RuntimeCatalog | undefined>(
    workspace.runtime,
  );
  const [discoveredTools, setDiscoveredTools] = useState<ToolChoice[]>([]);
  const [discoveringTools, setDiscoveringTools] = useState(false);
  const [toolsError, setToolsError] = useState<unknown>(null);
  const [modelsError, setModelsError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [publishedJevProfile, setPublishedJevProfile] =
    useState<JevProfileRevision | null>(null);
  const [pending, setPending] = useState(false);
  const [loadingSource, setLoadingSource] = useState(!!source && !restoreSaved);
  const [toolsRefresh, setToolsRefresh] = useState(0);
  const [modelsRefresh, setModelsRefresh] = useState(0);
  const [discoveringModels, setDiscoveringModels] = useState(false);
  const agentCatalog = useRoleCatalog(
    runtime,
    draft.harness,
    draft.providerConnectionId,
    draft.providerConnectionProvider,
    draftReady && draft.targetKind === "managed",
  );
  const judgeCatalog = useRoleCatalog(
    runtime,
    draft.judgeHarness,
    draft.judgeProviderConnectionId,
    draft.judgeProviderConnectionProvider,
    draftReady && draft.judge,
  );
  const researchCatalog = useRoleCatalog(
    runtime,
    draft.researcherHarness,
    draft.researcherProviderConnectionId,
    draft.researcherProviderConnectionProvider,
    draftReady && draft.research && draft.targetKind === "managed",
  );
  const set = <K extends keyof SetupDraft>(key: K, value: SetupDraft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  const discoverTools = async () => {
    setToolsRefresh((value) => value + 1);
  };
  useEffect(() => {
    const controller = new AbortController();
    setToolsError(null);
    setDiscoveredTools([]);
    if (!draft.connectionId || draft.targetKind !== "managed" || !draftReady) {
      setDiscoveringTools(false);
      return;
    }
    setDiscoveringTools(true);
    void (async () => {
      try {
        const response = await command(
          "connections.test",
          { connectionId: draft.connectionId },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (!response.ok) throw new Error(response.message);
        const tools = parseToolCatalog(response.tools);
        setDiscoveredTools(tools);
        if (!tools.length)
          throw new Error(
            "The connection returned no tools. Inspect connection discovery in Settings.",
          );
      } catch (cause) {
        if (!controller.signal.aborted) setToolsError(cause);
      } finally {
        if (!controller.signal.aborted) setDiscoveringTools(false);
      }
    })();
    return () => controller.abort();
  }, [draft.connectionId, draft.targetKind, draftReady, toolsRefresh]);
  useEffect(() => {
    setModelsError(null);
    if (!draftReady || (draft.targetKind !== "managed" && !draft.judge)) {
      setDiscoveringModels(false);
      return;
    }
    const controller = new AbortController();
    setDiscoveringModels(true);
    void command("runtime.discover", {}, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setRuntime(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setModelsError(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted) setDiscoveringModels(false);
      });
    return () => controller.abort();
  }, [
    draft.targetKind,
    draft.harness,
    draft.judge,
    draft.judgeHarness,
    draft.research,
    draft.researcherHarness,
    draftReady,
    modelsRefresh,
  ]);
  useEffect(() => {
    if (!draftReady || acknowledged.current) return;
    if (!storageKey) {
      setStorageError(
        new Error(
          "Setup cannot be saved until the workspace identity is available.",
        ),
      );
      return;
    }
    try {
      if (
        JSON.stringify(draft) === JSON.stringify(initialSetup()) &&
        section === "agent" &&
        !pendingLaunch
      )
        sessionStorage.removeItem(storageKey);
      else
        sessionStorage.setItem(
          storageKey,
          encodeSetupDraft(draft, section, draftSource, pendingLaunch),
        );
      setStorageError(null);
    } catch (cause) {
      setStorageError(
        new Error(
          cause instanceof Error && cause.message.includes("credentials")
            ? cause.message
            : "This browser could not save the setup draft. Keep this page open until you start the run.",
        ),
      );
    }
  }, [draft, section, draftSource, draftReady, storageKey, pendingLaunch]);
  useEffect(() => {
    if (restoreSaved || !source) return;
    const controller = new AbortController();
    setLoadingSource(true);
    const blueprint = blueprintId
      ? workspace.blueprints.find((item) => item.id === blueprintId)
      : undefined;
    void hydrateSetupSource(
      { runId: sourceRunId, blueprint },
      {
        run: async (runId) =>
          (await command("runs.get", { runId }, controller.signal)).run,
        research: async (sessionId) =>
          (await command("research.get", { sessionId }, controller.signal))
            .session.configuration,
      },
    )
      .then((restored) => {
        if (!controller.signal.aborted) {
          setDraft(restored);
          setDraftReady(true);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingSource(false);
      });
    return () => controller.abort();
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
  const jevIssues = draft.jevEnabled
    ? jevConfigurationIssues(
        draft.jevSelection,
        workspace.connections,
        detail.data ?? undefined,
        publishedJevProfile ? [publishedJevProfile] : [],
      )
    : undefined;
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
    let request = pendingLaunch;
    let persisted = !!request;
    try {
      if (!request) {
        const input = {
          ...createLaunch(draft),
          idempotencyKey: crypto.randomUUID(),
        };
        request = pendingLaunchSchema.parse(
          draft.research && draft.targetKind === "managed"
            ? {
                operation: "research.launch",
                input: {
                  ...researchOptions.parse(objectJson(draft.researchSettings)),
                  name: draft.name,
                  baseline: input,
                  researcher: {
                    harness: draft.researcherHarness,
                    model: draft.researcherModel,
                    systemPrompt: initialSetup().researcherPrompt,
                    settings: roleSettings(
                      draft.researcherSettings,
                      draft.researcherProviderConnectionId,
                    ),
                    tools: draft.originalResearcher?.tools ?? [],
                    connections: draft.researcherProviderConnectionId
                      ? [
                          {
                            connectionId: draft.researcherProviderConnectionId,
                            provider:
                              draft.researcherProviderConnectionProvider,
                            settings:
                              draft.originalResearcher?.connections.find(
                                (item) =>
                                  item.connectionId ===
                                  draft.researcherProviderConnectionId,
                              )?.settings ?? {},
                            credentialFields:
                              draft.originalResearcher?.connections.find(
                                (item) =>
                                  item.connectionId ===
                                  draft.researcherProviderConnectionId,
                              )?.credentialFields ?? [],
                            credentialBinding:
                              draft.originalResearcher?.connections.find(
                                (item) =>
                                  item.connectionId ===
                                  draft.researcherProviderConnectionId,
                              )?.credentialBinding,
                          },
                        ]
                      : [],
                  },
                  objective: draft.researchInstructions,
                  guidance: "",
                  allowResearcherStop: draft.allowResearcherStop,
                  stopGuidance: draft.stopGuidance || undefined,
                  selectionMetric: draft.selectionMetric,
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
                },
              }
            : { operation: "runs.launch", input },
        );
        if (!storageKey)
          throw new Error(
            "Wait for the workspace identity before starting a run.",
          );
        sessionStorage.setItem(
          storageKey,
          encodeSetupDraft(draft, section, draftSource, request),
        );
        persisted = true;
        acknowledged.current = false;
        setPendingLaunch(request);
      }
      let destination: string;
      if (request.operation === "research.launch") {
        const result = await command("research.launch", request.input);
        if (!result.session.currentRunId)
          throw new Error(
            "The engine did not return a baseline Run for this research launch.",
          );
        destination = `/runs/${result.session.currentRunId}?session=${result.session.id}`;
      } else {
        const result = await command("runs.launch", request.input);
        destination = `/runs/${result.run.id}`;
      }
      if (!mounted.current) return;
      acknowledged.current = true;
      setPendingLaunch(undefined);
      try {
        if (storageKey) sessionStorage.removeItem(storageKey);
      } catch {
        /* The accepted request remains safely replayable if storage is unavailable. */
      }
      navigate(destination);
      refresh();
    } catch (cause) {
      if (!mounted.current) return;
      if (
        cause instanceof CommandError &&
        cause.status >= 400 &&
        cause.status < 500 &&
        cause.code !== "conflict"
      ) {
        setPendingLaunch(undefined);
        setError(cause);
      } else if (persisted) {
        setError(
          new Error(
            `${cause instanceof Error ? cause.message : String(cause)} Retry launch to recover this same request.`,
          ),
        );
      } else setError(cause);
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  if (loadingSource)
    return <div className="loading">Loading frozen run configuration...</div>;
  return (
    <>
      <PageHeading
        title="New run"
        description="Choose an agent and question bank, then review your evaluation settings."
      >
        <button
          className="button secondary"
          disabled={pending}
          onClick={() => {
            if (
              !window.confirm(
                pendingLaunch
                  ? "This launch might already be saved. Retry launch to recover it, or reset to start a separate evaluation?"
                  : "Discard this setup draft and start fresh?",
              )
            )
              return;
            try {
              if (storageKey) sessionStorage.removeItem(storageKey);
            } catch {
              /* Reported by the persistence effect. */
            }
            acknowledged.current = false;
            setPendingLaunch(undefined);
            setDraft(initialSetup());
            setSection("agent");
            setDraftSource("");
            setDraftReady(true);
            setError(null);
            navigate("/runs/new");
          }}
        >
          Reset setup
        </button>
      </PageHeading>
      <ErrorNotice error={error} />
      <ErrorNotice error={storageError} />
      <ErrorNotice error={toolsError} />
      <ErrorNotice error={modelsError} />
      <ErrorNotice
        error={draft.targetKind === "managed" ? agentCatalog.error : undefined}
      />
      <ErrorNotice error={draft.judge ? judgeCatalog.error : undefined} />
      <ErrorNotice error={draft.research ? researchCatalog.error : undefined} />
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
              .map(([id, label, description]) => (
                <button
                  key={id}
                  className={section === id ? "active" : ""}
                  aria-current={section === id ? "step" : undefined}
                  aria-controls="setup-section"
                  onClick={() => setSection(id)}
                >
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
          <section
            className="panel setup-main"
            id="setup-section"
            aria-label="Selected setup section"
          >
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
                      "Choose a question bank and the questions to test. Expected answers stay private to the evaluator.",
                    agent:
                      draft.targetKind === "external"
                        ? "Select a deployed HTTP agent. Its own system controls models, instructions, and tools. This app evaluates the answers."
                        : "Configure the agent that answers your questions. Choose its model, sign-in method, and instructions. This is separate from the researcher and judges.",
                    tools:
                      "Choose a saved Tableau connection and the actions the agent can use. The app manages the MCP server. A resource ID guides the agent; it does not restrict access.",
                    evaluation:
                      "Choose how often to repeat each question and how long to wait. Deterministic grading always runs. Optional judges record separate assessments.",
                    research:
                      "Optionally let a researcher improve the tested agent after its baseline run. Questions stay fixed. Choose what the researcher can change and when it must stop.",
                  }[section]
                }
              </Help>
            </div>
            <fieldset
              className="panel-body stack setup-fields"
              disabled={pending || !!pendingLaunch}
            >
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
                      disabled={discoveringModels}
                      onClick={() => {
                        setModelsRefresh((value) => value + 1);
                        agentCatalog.refresh();
                        judgeCatalog.refresh();
                        researchCatalog.refresh();
                      }}
                    >
                      {discoveringModels
                        ? "Discovering models..."
                        : "Refresh available models"}
                    </button>
                  )}
                  <Field
                    label="Agent type"
                    help="Configure a local agent here, or evaluate answers from an agent deployed behind an HTTP endpoint."
                  >
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
                      catalog={agentCatalog.catalog}
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
                  catalog={judgeCatalog.catalog}
                  bankRecord={bankRecord}
                  evaluatorRevisions={detail.data?.evaluatorRevisions ?? []}
                  connections={workspace.connections}
                  onJevProfilePublished={setPublishedJevProfile}
                />
              )}
              {section === "research" && (
                <ResearchSettings
                  draft={draft}
                  set={set}
                  setDraft={setDraft}
                  catalog={researchCatalog.catalog}
                  connections={workspace.connections}
                />
              )}
            </fieldset>
            <footer className="setup-footer">
              <span>
                {bank
                  ? `${selectedQuestionIds(draft, bank.questions).length} questions × ${draft.repetitions} repetitions`
                  : "Choose a question bank"}
              </span>
              {section !== "evaluation" &&
                (jevIssues?.connection || jevIssues?.profile) && (
                  <span className="notice" role="status">
                    {jevIssues.connection ?? jevIssues.profile} Review the
                    Evaluation section to update Jev setup.
                  </span>
                )}
              <button
                className="button primary"
                disabled={
                  pending ||
                  (!pendingLaunch &&
                    (!draftReady ||
                      !bank ||
                      !!jevIssues?.connection ||
                      !!jevIssues?.profile ||
                      (draft.questionSelection === "selected" &&
                        !draft.questionIds.length) ||
                      (draft.targetKind === "external"
                        ? !draft.externalTarget
                        : !draft.model.trim())))
                }
                onClick={() => {
                  void launch();
                }}
              >
                <Icon name="run" size={16} />
                {pending
                  ? "Starting..."
                  : pendingLaunch
                    ? "Retry launch"
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
