import { HARNESS_LABELS, supportsProvider } from "../contracts/harnesses.js";
import type {
  AgentConfig,
  RuntimeCatalog,
  WorkspaceView,
} from "../contracts.js";
import { Field } from "./ui.js";

export function RoleProvider({
  label,
  connections,
  value,
  onChange,
  harness = "opencode",
}: {
  label: string;
  harness?: string;
  connections: WorkspaceView["connections"];
  value: string;
  onChange: (id: string, provider: string) => void;
}) {
  return (
    <Field
      label={label}
      help="Use a subscription or local account through the selected harness, or choose a saved API key or gateway token. Configure saved credentials in Settings, Connections."
    >
      <select
        aria-label={label}
        value={value}
        onChange={(event) =>
          onChange(
            event.target.value,
            connections.find((item) => item.id === event.target.value)
              ?.provider ?? "",
          )
        }
      >
        <option value="">
          {harness === "bedrock"
            ? "Choose a saved Bedrock connection"
            : "Subscription / local harness account"}
        </option>
        {value &&
          !connections.some(
            (item) =>
              item.id === value && supportsProvider(harness, item.provider),
          ) && (
            <option value={value}>
              Previously selected connection (unavailable or incompatible)
            </option>
          )}
        {connections
          .filter((item) => supportsProvider(harness, item.provider))
          .map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} (
              {item.settings.authMode === "bearer" ? "bearer token" : "API key"}{" "}
              / {item.provider})
            </option>
          ))}
      </select>
      {harness === "bedrock" && (
        <p className="subtle">
          Uses non-streaming Converse with the saved gateway bearer token.
          Subscription sign-in does not apply.
        </p>
      )}
      {value &&
        !connections.some(
          (item) =>
            item.id === value && supportsProvider(harness, item.provider),
        ) && (
          <p className="warning">
            Choose a compatible saved connection. The previous selection has
            been preserved.
          </p>
        )}
    </Field>
  );
}

export function ModelFields({
  catalog,
  harness,
  model,
  onHarness,
  onModel,
  prefix = "",
}: {
  catalog?: RuntimeCatalog;
  harness: AgentConfig["harness"];
  model: string;
  onHarness: (value: AgentConfig["harness"]) => void;
  onModel: (value: string) => void;
  prefix?: string;
}) {
  const selected = catalog?.harnesses.find((item) => item.id === harness);
  return (
    <>
      <div className="form-grid">
        <Field label={`${prefix}harness`} required>
          <select
            aria-label={`${prefix}harness`}
            value={harness}
            onChange={(event) =>
              onHarness(event.target.value as AgentConfig["harness"])
            }
          >
            {(catalog?.harnesses.length
              ? catalog.harnesses
              : [
                  { id: "codex", available: false },
                  { id: "opencode", available: false },
                  { id: "claude", available: false },
                  { id: "bedrock", available: true },
                ]
            ).map((item) => (
              <option key={item.id} value={item.id}>
                {HARNESS_LABELS[item.id as keyof typeof HARNESS_LABELS] ??
                  item.id}
                {item.available ? "" : " (not discovered)"}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={`${prefix}model`}
          required
          help="Choose an actually discovered model, or enter the model ID configured in your harness. Discovery does not guarantee account entitlement."
        >
          <input
            aria-label={`${prefix}model`}
            list={`models-${prefix || "agent"}`}
            value={model}
            onChange={(event) => onModel(event.target.value)}
            placeholder="Choose or enter model ID"
          />
          <datalist id={`models-${prefix || "agent"}`}>
            {selected?.models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </datalist>
        </Field>
      </div>
      {selected && (
        <p className={`runtime-note ${selected.available ? "" : "warning"}`}>
          {selected.available
            ? selected.id === "bedrock"
              ? "Built-in non-streaming Bedrock Converse runtime. Select a saved gateway connection and enter its model ID."
              : `${selected.id} ${selected.version ?? ""} is installed.`
            : (selected.error ?? `${selected.id} is unavailable.`)}
          {selected.id === "bedrock"
            ? ""
            : selected.authenticated === true
              ? " Local account detected."
              : selected.authenticated === false
                ? " Sign in through the harness CLI or choose a saved API key or gateway token."
                : " Account status is unknown."}
        </p>
      )}
    </>
  );
}
