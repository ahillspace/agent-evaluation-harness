import type { WorkspaceView } from "../contracts.js";
import type { SetupDraftProps } from "./setup-types.js";
import { ToolCatalog, type ToolChoice } from "./tools.js";
import { Field, Icon } from "./ui.js";

export function RunTools({
  draft,
  workspace,
  set,
  discoveredTools,
  discoveringTools,
  discoverTools,
}: Pick<SetupDraftProps, "draft" | "set"> & {
  workspace: Pick<WorkspaceView, "connections">;
  discoveredTools: ToolChoice[];
  discoveringTools: boolean;
  discoverTools: () => Promise<void>;
}) {
  return (
    <>
      <Field
        label="Tableau connection"
        help="The connection binds the agent to your Tableau site. Its credentials stay in runtime storage."
      >
        <select
          aria-label="Tableau connection"
          value={draft.connectionId}
          onChange={(event) => set("connectionId", event.target.value)}
        >
          <option value="">No Tableau connection</option>
          {workspace.connections
            .filter((item) => item.provider === "tableau")
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
        </select>
      </Field>
      {!workspace.connections.some((item) => item.provider === "tableau") && (
        <a className="inline-link" href="#/settings">
          Set up a Tableau connection <Icon name="arrow" size={14} />
        </a>
      )}
      {draft.connectionId && (
        <Field
          label="Datasource or resource ID"
          help="Scope analytics tools to this Tableau resource. Leave blank when your tools support choosing resources per question."
        >
          <input
            aria-label="Datasource or resource ID"
            value={draft.resourceId}
            onChange={(event) => set("resourceId", event.target.value)}
            placeholder="Optional resource ID"
          />
        </Field>
      )}
      <div className="notice">
        <Icon name="tool" />
        Give the agent only the capabilities required by your questions.
      </div>
      <div className="row">
        <div>
          <h3>Available connection tools</h3>
          <p className="subtle">
            Discover actual tools from the selected Tableau connection.
          </p>
        </div>
        <button
          className="button secondary"
          disabled={!draft.connectionId || discoveringTools}
          onClick={() => {
            void discoverTools();
          }}
        >
          {discoveringTools ? "Discovering..." : "Discover tools"}
        </button>
      </div>
      {!draft.connectionId && (
        <p className="subtle">
          Choose a connection under Questions & data to discover its tools.
        </p>
      )}
      {discoveredTools.length > 0 && (
        <ToolCatalog
          tools={discoveredTools}
          selected={draft.tools
            .split(/[\n,]/)
            .map((value) => value.trim())
            .filter(Boolean)}
          onChange={(names) => set("tools", names.join("\n"))}
        />
      )}
      <Field
        label="Tool allowlist"
        required
        help="Enter tool names, one per line or separated by commas. Tools outside the allowlist stay unavailable. Empty means no tools."
      >
        <textarea
          aria-label="Tool allowlist"
          rows={9}
          className="code-input"
          value={draft.tools}
          onChange={(event) => set("tools", event.target.value)}
          placeholder="Enter the exact tool names from connection discovery"
        />
      </Field>
      <p className="subtle">
        Test your connection in <a href="#/settings">Settings</a> to inspect its
        available tools. Tool names are preserved in exported agent JSON.
      </p>
      <details className="disclosure">
        <summary>Tool configuration details</summary>
        <p className="subtle">
          Connection settings and the selected resource are frozen at launch.
          Review these under Questions & data.
        </p>
        <p className="subtle">
          Local harness tools also require explicit names in this allowlist.
          Unsupported tools fail validation instead of being silently enabled.
        </p>
      </details>
    </>
  );
}
