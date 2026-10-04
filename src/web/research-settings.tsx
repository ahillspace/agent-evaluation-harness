import type { Dispatch, SetStateAction } from "react";
import type { RuntimeCatalog, WorkspaceView } from "../contracts.js";
import type { SetupDraft } from "./drafts.js";
import { ModelFields, RoleProvider } from "./model-fields.js";
import { Field, Icon } from "./ui.js";

export function ResearchSettings({
  draft,
  set,
  setDraft,
  catalog,
  connections,
}: {
  draft: SetupDraft;
  set: <K extends keyof SetupDraft>(key: K, value: SetupDraft[K]) => void;
  setDraft: Dispatch<SetStateAction<SetupDraft>>;
  catalog?: RuntimeCatalog;
  connections: WorkspaceView["connections"];
}) {
  return (
    <>
      <label className="check-row">
        <input
          type="checkbox"
          checked={draft.research}
          onChange={(event) => set("research", event.target.checked)}
        />
        <span>
          <strong>Enable autoresearch</strong>
          <small>
            Evaluate a baseline, then propose and evaluate candidate
            configurations.
          </small>
        </span>
      </label>
      {draft.research ? (
        <>
          <ModelFields
            prefix="Researcher "
            catalog={catalog}
            harness={draft.researcherHarness}
            model={draft.researcherModel}
            onHarness={(value) => set("researcherHarness", value)}
            onModel={(value) => set("researcherModel", value)}
          />
          <Field label="Research objective">
            <textarea
              aria-label="Research objective"
              rows={3}
              value={draft.objective}
              onChange={(event) => set("objective", event.target.value)}
            />
          </Field>
          <Field label="Researcher instructions">
            <textarea
              aria-label="Researcher instructions"
              rows={4}
              value={draft.researcherPrompt}
              onChange={(event) => set("researcherPrompt", event.target.value)}
            />
          </Field>
          <RoleProvider
            label="Researcher authentication"
            connections={connections}
            value={draft.researcherProviderConnectionId}
            onChange={(id, provider) =>
              setDraft((value) => ({
                ...value,
                researcherProviderConnectionId: id,
                researcherProviderConnectionProvider: provider,
              }))
            }
          />
          <Field label="Guidance">
            <textarea
              aria-label="Research guidance"
              rows={3}
              value={draft.guidance}
              onChange={(event) => set("guidance", event.target.value)}
              placeholder="Constraints and useful context for the researcher"
            />
          </Field>
          <div className="form-grid">
            <Field label="Maximum candidates">
              <input
                aria-label="Maximum candidates"
                type="number"
                min="1"
                max="100"
                value={draft.maxCandidates}
                onChange={(event) =>
                  set("maxCandidates", Number(event.target.value))
                }
              />
            </Field>
            <Field label="Maximum duration (minutes)">
              <input
                aria-label="Maximum research duration"
                type="number"
                min="1"
                max="1440"
                value={draft.maxMinutes}
                onChange={(event) =>
                  set("maxMinutes", Number(event.target.value))
                }
              />
            </Field>
          </div>
          <p className="subtle">
            The researcher retains one provider conversation. Evidence retrieval
            is explicit, and access to expected answers is audited.
          </p>
          <details className="disclosure">
            <summary>Advanced research limits and objectives</summary>
            <div className="stack">
              <div className="form-grid">
                <Field
                  label="Maximum target invocations"
                  help="Counts physical target attempts, including retries after interruption."
                >
                  <input
                    aria-label="Maximum target invocations"
                    type="number"
                    min="1"
                    max="100000"
                    value={draft.maxTargetInvocations}
                    onChange={(event) =>
                      set("maxTargetInvocations", Number(event.target.value))
                    }
                  />
                </Field>
                <Field label="Maximum researcher turns">
                  <input
                    aria-label="Maximum researcher turns"
                    type="number"
                    min="1"
                    max="1000"
                    value={draft.maxResearcherTurns}
                    onChange={(event) =>
                      set("maxResearcherTurns", Number(event.target.value))
                    }
                  />
                </Field>
              </div>
              <div className="form-grid">
                <Field
                  label="Total token budget"
                  help="Optional cumulative budget across target, judge, and researcher usage. Leave blank to use the other configured limits."
                >
                  <input
                    aria-label="Total token budget"
                    type="number"
                    min="1"
                    value={draft.maxTotalTokens}
                    onChange={(event) =>
                      set("maxTotalTokens", event.target.value)
                    }
                    placeholder="Optional"
                  />
                </Field>
                <Field
                  label="Cost budget (USD)"
                  help="Optional cumulative spending limit. Unknown provider cost remains unknown; the engine enforces its supported budget policy."
                >
                  <input
                    aria-label="Cost budget (USD)"
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={draft.maxCostUsd}
                    onChange={(event) => set("maxCostUsd", event.target.value)}
                    placeholder="Optional"
                  />
                </Field>
              </div>
              <Field label="Researcher model settings">
                <textarea
                  aria-label="Researcher model settings"
                  className="code-input"
                  rows={5}
                  value={draft.researcherSettings}
                  onChange={(event) =>
                    set("researcherSettings", event.target.value)
                  }
                />
              </Field>
              <Field
                label="Mutation space and objective configuration"
                help="allowedChanges lists systemPrompt, settings, tools, or model. searchSpace can bound models, tools, setting values, and maxSystemPromptLength. objectiveMetrics uses accuracy, tokens, or duration with direction maximize/minimize and a weight; objectiveMode is lexicographic or weighted."
              >
                <textarea
                  aria-label="Research mutation and objective settings"
                  className="code-input"
                  rows={13}
                  value={draft.researchSettings}
                  onChange={(event) =>
                    set("researchSettings", event.target.value)
                  }
                />
              </Field>
            </div>
          </details>
        </>
      ) : (
        <div className="quiet-card">
          <Icon name="agent" size={24} />
          <h3>Start with a manual evaluation</h3>
          <p>
            Research is optional. A manual run gives you a fixed baseline to
            inspect and compare.
          </p>
        </div>
      )}
    </>
  );
}
