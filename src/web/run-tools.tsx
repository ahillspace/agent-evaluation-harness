import type { WorkspaceView } from "../contracts.js";
import type { SetupDraftProps } from "./setup-types.js";
import { ToolCatalog, type ToolChoice } from "./tools.js";
import { Field } from "./ui.js";
import { ConnectionResources } from "./connection-resources.js";

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
  const connections = workspace.connections;
  const environment = connections.find((item) => item.id === draft.connectionId)
    ?.settings.mcpEnv;
  const datasourceScope =
    environment &&
    typeof environment === "object" &&
    !Array.isArray(environment)
      ? environment.INCLUDE_DATASOURCE_IDS
      : undefined;
  return (
    <>
      <Field
        label="Tableau connection"
        help="Connect the agent to your Tableau site. Credentials stay private."
      >
        <select
          aria-label="Tableau connection"
          value={draft.connectionId}
          onChange={(event) => {
            set("connectionId", event.target.value);
            set("resourceId", "");
            set("resourceName", "");
            set("resourceProjectName", "");
          }}
        >
          <option value="">No Tableau connection</option>
          {connections
            .filter((item) => item.provider === "tableau")
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
        </select>
      </Field>
      <p className="subtle">
        <a href="#/settings/connections">
          Manage Tableau connections in Settings
        </a>
        . Your setup draft stays saved when you leave this page.
      </p>
      {draft.connectionId && (
        <ConnectionResources
          key={draft.connectionId}
          connectionId={draft.connectionId}
          selected={
            draft.resourceId
              ? {
                  id: draft.resourceId,
                  name:
                    draft.resourceName ||
                    `Saved datasource (${draft.resourceId})`,
                  projectName: draft.resourceProjectName || undefined,
                }
              : undefined
          }
          onChange={(resource) => {
            set("resourceId", resource?.id ?? "");
            set("resourceName", resource?.name ?? "");
            set("resourceProjectName", resource?.projectName ?? "");
          }}
        />
      )}
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
          Choose a connection above to discover its tools.
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
      <details className="disclosure" open={!discoveredTools.length}>
        <summary>Edit tool names manually</summary>
        <Field
          label="Tool allowlist"
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
      </details>
      <details className="disclosure">
        <summary>Tool configuration details</summary>
        {typeof datasourceScope === "string" && (
          <p className="subtle">
            Configured MCP datasource restriction:{" "}
            <code>{datasourceScope}</code>
          </p>
        )}
        {draft.connectionId && (
          <Field
            label="Datasource or resource ID"
            help="The exact datasource LUID is preserved at launch. Enter an ID here if discovery is unavailable."
          >
            <input
              aria-label="Datasource or resource ID"
              value={draft.resourceId}
              onChange={(event) => {
                set("resourceId", event.target.value);
                set("resourceName", "");
                set("resourceProjectName", "");
              }}
              placeholder="Optional resource ID"
            />
          </Field>
        )}
        <p className="subtle">
          Connection settings and the selected resource are frozen at launch.
          Exported agent JSON preserves these settings.
        </p>
        <p className="subtle">
          Local harness tools also require explicit names in this allowlist.
          Unsupported tools fail validation instead of being silently enabled.
        </p>
      </details>
    </>
  );
}
