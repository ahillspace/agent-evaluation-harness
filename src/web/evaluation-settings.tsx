import { JsonEditor } from "./json-editor.js";
import { modelSettingsGuide } from "./json-guides.js";
import { validateModelSettings } from "../contracts/model-settings.js";
import type {
  BankSummary,
  BankDetail,
  EvaluatorRevision,
  RuntimeCatalog,
  WorkspaceView,
} from "../contracts.js";
import type { SetupDraftProps } from "./setup-types.js";
import { ModelFields, RoleProvider } from "./model-fields.js";
import { Field } from "./ui.js";
import { JevConfiguration } from "./jev-configuration.js";

export function EvaluationSettings({
  draft,
  set,
  setDraft,
  catalog,
  bankRecord,
  evaluatorRevisions,
  connections,
  bankDetail,
  refreshBank,
}: SetupDraftProps & {
  catalog?: RuntimeCatalog;
  bankRecord?: BankSummary;
  evaluatorRevisions: EvaluatorRevision[];
  connections: WorkspaceView["connections"];
  bankDetail?: BankDetail;
  refreshBank: () => void;
}) {
  return (
    <>
      <div className="form-grid">
        <Field
          label="Repetitions"
          help="Each repetition evaluates the entire selected question set using the same frozen configuration."
        >
          <input
            aria-label="Repetitions"
            type="number"
            min="1"
            max="100"
            value={draft.repetitions}
            onChange={(event) => set("repetitions", Number(event.target.value))}
          />
        </Field>
        <Field
          label="Evaluator revision"
          help="The selected published evaluator is frozen at launch. Later revisions do not change this run."
        >
          <select
            aria-label="Evaluator revision"
            value={draft.evaluatorRevisionId}
            onChange={(event) => set("evaluatorRevisionId", event.target.value)}
          >
            <option value="">Active evaluator at launch</option>
            {evaluatorRevisions
              .filter((item) => item.bankId === bankRecord?.id)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · revision {item.number}
                </option>
              ))}
          </select>
        </Field>
      </div>
      <div className="form-grid">
        <Field
          label="Question timeout (seconds)"
          help="Maximum time for one question attempt. External requests stop waiting at this deadline, but remote work might continue."
        >
          <input
            aria-label="Question timeout"
            type="number"
            min="1"
            max="3600"
            value={draft.timeoutSeconds}
            onChange={(event) =>
              set("timeoutSeconds", Number(event.target.value))
            }
          />
        </Field>
        <Field
          label="Concurrent questions"
          help="The application and runtime enforce capacity. Start with one for a readable observation trace."
        >
          <input
            aria-label="Concurrent questions"
            type="number"
            min="1"
            max={catalog?.maxConcurrency ?? 8}
            value={draft.concurrency}
            onChange={(event) => set("concurrency", Number(event.target.value))}
          />
        </Field>
      </div>
      <details className="disclosure">
        <summary>Advanced execution limits</summary>
        <Field
          label="Maximum recorded output (bytes)"
          help="The runtime stops an attempt that exceeds this output limit. The value is frozen and preserved when you reuse the run."
        >
          <input
            aria-label="Maximum recorded output"
            type="number"
            min="1024"
            max="16000000"
            value={draft.maxOutputBytes}
            onChange={(event) =>
              set("maxOutputBytes", Number(event.target.value))
            }
          />
        </Field>
      </details>
      <div className="divider" />
      <h3>Optional judging</h3>
      <p className="subtle">
        Deterministic evaluation always runs. Additional judges record
        independent assessments and can incur model usage.
      </p>
      <label className="check-row">
        <input
          type="checkbox"
          checked={draft.judge}
          onChange={(event) => set("judge", event.target.checked)}
        />
        <span>
          <strong>Add an LLM judge</strong>
          <small>
            Separate from deterministic accuracy. Disabled means no judge calls.
          </small>
        </span>
      </label>
      {draft.judge && (
        <Field
          label="Judge evidence requirements"
          help="External agents provide answers only. Internal actions cannot be inferred from missing traces."
        >
          <select
            aria-label="Judge evidence requirements"
            value={draft.judgeEvidenceRequirement}
            onChange={(event) =>
              set(
                "judgeEvidenceRequirement",
                event.target.value as typeof draft.judgeEvidenceRequirement,
              )
            }
          >
            <option value="answer">Answer evidence only</option>
            <option value="internal-activity">
              Internal activity required
            </option>
            <option value="unspecified">Unspecified</option>
          </select>
        </Field>
      )}
      {draft.judge && (
        <>
          <ModelFields
            prefix="Judge "
            catalog={catalog}
            harness={draft.judgeHarness}
            model={draft.judgeModel}
            onHarness={(value) => set("judgeHarness", value)}
            onModel={(value) => set("judgeModel", value)}
          />
          <Field label="Judge instructions">
            <textarea
              aria-label="Judge instructions"
              rows={4}
              value={draft.judgeInstructions}
              onChange={(event) => set("judgeInstructions", event.target.value)}
            />
          </Field>
          <RoleProvider
            harness={draft.judgeHarness}
            label="Judge authentication"
            connections={connections}
            value={draft.judgeProviderConnectionId}
            onChange={(id, provider) =>
              setDraft((value) => ({
                ...value,
                judgeProviderConnectionId: id,
                judgeProviderConnectionProvider: provider,
              }))
            }
          />
          <details className="disclosure">
            <summary>Advanced judge settings</summary>
            <Field
              label="Judge model settings"
              help="These settings belong to the judge independently of the target agent. The judge receives no target tools."
            >
              <JsonEditor
                label="Judge model settings"
                value={draft.judgeSettings}
                onChange={(value) => set("judgeSettings", value)}
                guide={modelSettingsGuide(draft.judgeHarness)}
                validate={(value) => {
                  validateModelSettings(draft.judgeHarness, value);
                }}
              />
            </Field>
          </details>
        </>
      )}
      <div className="divider" />
      <label className="check-row">
        <input
          type="checkbox"
          aria-label="Add Jev classification judge"
          checked={draft.jevEnabled}
          onChange={(event) => set("jevEnabled", event.target.checked)}
        />
        <span>
          <strong>Add Jev classification judge</strong>
          <small>Enable independently of the LLM judge, or use both.</small>
        </span>
      </label>
      {draft.jevEnabled && (
        <JevConfiguration
          value={draft.jevSelection}
          onChange={(value) => set("jevSelection", value)}
          connections={connections}
          bank={bankDetail}
          onPublished={refreshBank}
        />
      )}
    </>
  );
}
