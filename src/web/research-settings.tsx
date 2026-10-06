import { researchSchema } from "../contracts.js";
import { JsonEditor } from "./json-editor.js";
import { modelSettingsGuide, researchGuide } from "./json-guides.js";
import { validateModelSettings } from "../contracts/model-settings.js";
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
          <Field
            label="Researcher instructions"
            help="Describe the goal, constraints, and useful context in one place. The researcher evaluates each candidate against the same frozen questions and selection metric."
          >
            <textarea
              aria-label="Researcher instructions"
              rows={6}
              value={draft.researchInstructions}
              onChange={(event) =>
                set("researchInstructions", event.target.value)
              }
            />
          </Field>
          <RoleProvider
            harness={draft.researcherHarness}
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
          <Field
            label="Selection metric"
            help="The selected assessment source stays fixed throughout research. Accuracy uses every eligible question, including failed executions; coverage stays visible."
          >
            <select
              aria-label="Selection metric"
              value={draft.selectionMetric}
              onChange={(event) =>
                set(
                  "selectionMetric",
                  event.target.value as SetupDraft["selectionMetric"],
                )
              }
            >
              <option value="deterministic">Deterministic accuracy</option>
              <option value="llm" disabled={!draft.judge}>
                LLM judgment accuracy
                {!draft.judge ? " - enable the LLM judge first" : ""}
              </option>
              <option value="jev" disabled={!draft.jevEnabled}>
                Jev judgment accuracy
                {!draft.jevEnabled ? " - enable Jev first" : ""}
              </option>
            </select>
          </Field>
          <label className="check-row">
            <input
              type="checkbox"
              checked={draft.allowResearcherStop}
              onChange={(event) =>
                set("allowResearcherStop", event.target.checked)
              }
            />
            <span>
              <strong>Allow researcher to stop early</strong>
              <small>
                When enabled, the researcher can finish before the candidate
                budget. When disabled, lack of improvement alone cannot end
                research. Hard limits, cancellation, and technical blockers
                still stop work.
              </small>
            </span>
          </label>
          {draft.allowResearcherStop && (
            <Field
              label="Early stopping guidance"
              help="Optional instructions for when the researcher should finish. This guidance is sent to the researcher and does not change hard limits."
            >
              <textarea
                aria-label="Early stopping guidance"
                rows={2}
                value={draft.stopGuidance}
                onChange={(event) => set("stopGuidance", event.target.value)}
                placeholder="For example: stop after two distinct candidates show no improvement."
              />
            </Field>
          )}
          <div className="form-grid">
            <Field
              label="Maximum candidates"
              help="Maximum proposed configurations after the baseline. Each candidate runs the full selected question set and repetition count."
            >
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
            <Field
              label="Maximum duration (minutes)"
              help="Time budget for the research session, including the baseline and candidate evaluations."
            >
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
                <JsonEditor
                  label="Researcher model settings"
                  value={draft.researcherSettings}
                  onChange={(value) => set("researcherSettings", value)}
                  guide={modelSettingsGuide(draft.researcherHarness)}
                  validate={(value) => {
                    validateModelSettings(draft.researcherHarness, value);
                  }}
                />
              </Field>
              <Field
                label="Mutation space and objective configuration"
                help="allowedChanges lists systemPrompt, settings, tools, or model. searchSpace can bound models, tools, setting values, and maxSystemPromptLength. objectiveMetrics uses accuracy, tokens, or duration with direction maximize/minimize and a weight; objectiveMode is lexicographic or weighted."
              >
                <JsonEditor
                  label="Research mutation and objective settings"
                  value={draft.researchSettings}
                  onChange={(value) => set("researchSettings", value)}
                  guide={researchGuide}
                  validate={(value) => {
                    researchSchema
                      .pick({
                        allowedChanges: true,
                        searchSpace: true,
                        objectiveMode: true,
                        objectiveMetrics: true,
                      })
                      .strict()
                      .parse(value);
                  }}
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
