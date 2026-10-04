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
}: {
  label: string;
  connections: WorkspaceView["connections"];
  value: string;
  onChange: (id: string, provider: string) => void;
}) {
  return (
    <Field
      label={label}
      help="Use this role's local harness account, or select a saved provider API key independently of other roles."
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
        <option value="">Use local harness account</option>
        {connections
          .filter((item) =>
            ["openai", "anthropic", "openrouter"].includes(item.provider),
          )
          .map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} ({item.provider})
            </option>
          ))}
      </select>
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
                ]
            ).map((item) => (
              <option key={item.id} value={item.id}>
                {item.id}
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
            ? `${selected.id} ${selected.version ?? ""} is installed.`
            : (selected.error ?? `${selected.id} is unavailable.`)}
          {selected.authenticated === true
            ? " Local account detected."
            : selected.authenticated === false
              ? " Sign in through the harness CLI or choose a provider API key."
              : " Account status is unknown."}
        </p>
      )}
    </>
  );
}
