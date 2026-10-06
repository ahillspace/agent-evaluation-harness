import { JsonEditor } from "./json-editor.js";
import { modelSettingsGuide } from "./json-guides.js";
import { validateModelSettings } from "../contracts/model-settings.js";
import type { RuntimeCatalog, WorkspaceView } from "../contracts.js";
import type { SetupDraftProps } from "./setup-types.js";
import { ModelFields, RoleProvider } from "./model-fields.js";
import { Field } from "./ui.js";

export function AgentSettings({
  draft,
  set,
  catalog,
  connections,
}: Pick<SetupDraftProps, "draft" | "set"> & {
  catalog?: RuntimeCatalog;
  connections: WorkspaceView["connections"];
}) {
  return (
    <>
      <ModelFields
        catalog={catalog}
        harness={draft.harness}
        model={draft.model}
        onHarness={(value) => {
          set("harness", value);
          set("model", "");
        }}
        onModel={(value) => set("model", value)}
      />
      <RoleProvider
        harness={draft.harness}
        label="Agent authentication"
        connections={connections}
        value={draft.providerConnectionId}
        onChange={(id, provider) => {
          set("providerConnectionId", id);
          set("providerConnectionProvider", provider);
        }}
      />
      <Field
        label="System prompt"
        required
        help="These instructions apply to every target question. Never place question-specific expected answers in the prompt."
      >
        <textarea
          aria-label="System prompt"
          rows={7}
          value={draft.prompt}
          onChange={(event) => set("prompt", event.target.value)}
        />
      </Field>
      <details className="disclosure">
        <summary>Advanced agent settings</summary>
        <JsonEditor
          label="Advanced agent settings"
          value={draft.settings}
          onChange={(value) => set("settings", value)}
          guide={modelSettingsGuide(draft.harness)}
          validate={(value) => {
            validateModelSettings(draft.harness, value);
          }}
        />
      </details>
    </>
  );
}
