import { useState } from "react";
import {
  judgeSchema,
  type AgentConfig,
  type JevJudgeSelection,
  type RunView,
  type WorkspaceView,
} from "../contracts.js";
import { command, useResource } from "./api.js";
import { JevConfiguration } from "./jev-configuration.js";
import { ModelFields, RoleProvider } from "./model-fields.js";
import { ReferenceSelector } from "./reference-selector.js";
import { ErrorNotice, Field, Modal } from "./ui.js";
import { JsonEditor } from "./json-editor.js";
import { modelSettingsGuide } from "./json-guides.js";
import { validateModelSettings } from "../contracts/model-settings.js";
import { roleSettings } from "./drafts.js";
import { useRoleCatalog } from "./setup-discovery.js";

export function AssessmentDialog({
  view,
  workspace,
  onClose,
  onSaved,
}: {
  view: RunView;
  workspace?: WorkspaceView;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const { run } = view;
  const bank = useResource("banks.get", { bankId: run.manifest.bank.bankId });
  const [source, setSource] = useState<"deterministic" | "llm" | "jev">(
    "deterministic",
  );
  const [name, setName] = useState("");
  const [evaluatorId, setEvaluatorId] = useState(run.manifest.evaluator.id);
  const [referenceId, setReferenceId] = useState("");
  const [agent, setAgent] = useState<AgentConfig>(
    () =>
      run.manifest.judge.agent ?? {
        harness: "codex",
        model: "",
        systemPrompt: "Assess saved answers using the supplied instructions.",
        settings: {},
        tools: [],
        connections: [],
      },
  );
  const [instructions, setInstructions] = useState(
    run.manifest.judge.instructions ?? judgeSchema.parse({}).instructions,
  );
  const [settings, setSettings] = useState(
    JSON.stringify(agent.settings, null, 2),
  );
  const runtime = useResource(
    "runtime.discover",
    {},
    undefined,
    source === "llm",
  );
  const judgeCatalog = useRoleCatalog(
    runtime.data ?? workspace?.runtime,
    agent.harness,
    agent.connections[0]?.connectionId ?? "",
    agent.connections[0]?.provider ?? "",
    source === "llm",
  );
  const [evidenceRequirement, setEvidenceRequirement] = useState<
    "answer" | "internal-activity"
  >("answer");
  const [jev, setJev] = useState<JevJudgeSelection>(() => ({
    connectionId: run.manifest.jevJudge?.connection.connectionId ?? "",
    model: run.manifest.jevJudge?.model ?? "jev-1.13.0",
    profileRevisionId: run.manifest.jevJudge?.profile.id,
  }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const canJudge = view.results.some((result) => result.status === "completed");
  const create = async () => {
    setPending(true);
    setError(null);
    try {
      const result = await command("runs.assess", {
        runId: run.id,
        name: name.trim(),
        source,
        evaluatorRevisionId:
          source === "deterministic" ? evaluatorId : undefined,
        bankRevisionId: referenceId || undefined,
        judge:
          source === "llm"
            ? {
                enabled: true,
                instructions,
                evidenceRequirement,
                agent: {
                  ...agent,
                  settings: roleSettings(
                    settings,
                    agent.connections[0]?.connectionId ?? "",
                  ),
                },
              }
            : undefined,
        jevJudge: source === "jev" ? jev : undefined,
      });
      onSaved(result.id);
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal title="Score saved answers" onClose={onClose}>
      <p className="subtle">
        Create a named score from recorded answers without running the agent
        again. Earlier scores stay available. Model judges use your selected
        provider and can incur usage charges.
      </p>
      <ErrorNotice
        error={error ?? bank.error ?? runtime.error ?? judgeCatalog.error}
      />
      {pending && (
        <p className="notice" role="status">
          Your assessment saves as it progresses. You can close this window and
          follow it in Saved score.
        </p>
      )}
      <fieldset className="judge-fieldset stack" disabled={pending}>
        <Field label="Score name">
          <input
            aria-label="Score name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="For example, reviewed rules or Jev assessment"
          />
        </Field>
        <Field label="Evaluation method">
          <select
            aria-label="Evaluation method"
            value={source}
            onChange={(event) => setSource(event.target.value as typeof source)}
          >
            <option value="deterministic">Answer rules</option>
            <option value="jev">Jev</option>
            <option value="llm">LLM judge</option>
          </select>
        </Field>
        {source === "deterministic" && (
          <Field label="Published evaluation standard">
            <select
              aria-label="Published evaluation standard"
              value={evaluatorId}
              onChange={(event) => setEvaluatorId(event.target.value)}
            >
              {(bank.data?.evaluatorRevisions ?? [run.manifest.evaluator]).map(
                (item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · revision {item.number}
                  </option>
                ),
              )}
            </select>
          </Field>
        )}
        <ReferenceSelector
          revisions={bank.data?.revisions ?? []}
          value={referenceId}
          onChange={setReferenceId}
        />
        {source === "jev" && (
          <JevConfiguration
            value={jev}
            onChange={setJev}
            connections={workspace?.connections ?? []}
            bank={bank.data ?? undefined}
            onPublished={bank.refresh}
          />
        )}
        {source === "llm" && (
          <>
            <ModelFields
              prefix="Judge "
              catalog={judgeCatalog.catalog}
              harness={agent.harness}
              model={agent.model}
              onHarness={(harness) =>
                setAgent({ ...agent, harness, model: "" })
              }
              onModel={(model) => setAgent({ ...agent, model })}
            />
            {!runtime.data && !runtime.error && (
              <p className="subtle" role="status">
                Discovering available judge models...
              </p>
            )}
            <RoleProvider
              label="Judge authentication"
              harness={agent.harness}
              connections={workspace?.connections ?? []}
              value={agent.connections[0]?.connectionId ?? ""}
              onChange={(connectionId, provider) =>
                setAgent({
                  ...agent,
                  connections: connectionId
                    ? [
                        {
                          connectionId,
                          provider,
                          settings: {},
                          credentialFields: [],
                        },
                      ]
                    : [],
                })
              }
            />
            <Field label="Judge instructions">
              <textarea
                aria-label="Judge instructions"
                rows={5}
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
              />
            </Field>
            <details className="disclosure">
              <summary>Advanced judge settings</summary>
              <Field label="Evidence to assess">
                <select
                  aria-label="Evidence to assess"
                  value={evidenceRequirement}
                  onChange={(event) =>
                    setEvidenceRequirement(
                      event.target.value as typeof evidenceRequirement,
                    )
                  }
                >
                  <option value="answer">Answer and reference</option>
                  <option value="internal-activity">
                    Recorded internal activity required
                  </option>
                </select>
              </Field>
              <JsonEditor
                label="Judge model settings"
                value={settings}
                onChange={setSettings}
                guide={modelSettingsGuide(agent.harness)}
                validate={(value) =>
                  validateModelSettings(agent.harness, value)
                }
              />
            </details>
          </>
        )}
        {!canJudge && (
          <p className="subtle">
            Record at least one completed answer before creating another score.
          </p>
        )}
        <button
          className="button primary"
          disabled={
            !canJudge ||
            !name.trim() ||
            (source === "llm" && !agent.model.trim()) ||
            (source === "jev" && !jev.connectionId)
          }
          onClick={() => {
            void create();
          }}
        >
          {pending ? "Assessing saved answers..." : "Create saved score"}
        </button>
      </fieldset>
    </Modal>
  );
}
