import { JsonEditor } from "./json-editor.js";
import { tableauConnectionGuide } from "./json-guides.js";
import { useState } from "react";
import type { ConnectionRecord, Json } from "../contracts.js";
import { command } from "./api.js";
import { objectJson } from "./drafts.js";
import { ErrorNotice, Field, Modal } from "./ui.js";

export function ConnectionEditor({
  connection,
  onClose,
  onSaved,
  defaultProvider = "tableau",
}: {
  connection: ConnectionRecord | "new";
  onClose: () => void;
  onSaved: (connection?: ConnectionRecord) => void;
  defaultProvider?: "tableau" | "typesafe";
}) {
  const initial = connection === "new" ? undefined : connection;
  const [name, setName] = useState(initial?.name ?? "");
  const [provider, setProvider] = useState(
    initial?.provider ?? defaultProvider,
  );
  const [server, setServer] = useState(String(initial?.settings.server ?? ""));
  const [site, setSite] = useState(String(initial?.settings.site ?? ""));
  const [patName, setPatName] = useState(
    String(initial?.settings.patName ?? ""),
  );
  const [baseUrl, setBaseUrl] = useState(
    String(initial?.settings.baseUrl ?? ""),
  );
  const [authMode, setAuthMode] = useState(
    String(
      initial?.settings.authMode ??
        (initial?.provider === "amazon-bedrock" ? "bearer" : "api-key"),
    ),
  );
  const [region, setRegion] = useState(String(initial?.settings.region ?? ""));
  const [secret, setSecret] = useState("");
  const [advanced, setAdvanced] = useState(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(initial?.settings ?? {}).filter(
          ([key]) =>
            ![
              "server",
              "site",
              "patName",
              "baseUrl",
              "authMode",
              "region",
            ].includes(key),
        ),
      ),
      null,
      2,
    ),
  );
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const save = async () => {
    setPending(true);
    setError(null);
    try {
      const settings: Record<string, Json> =
        provider === "typesafe"
          ? {}
          : {
              ...(provider === "tableau"
                ? objectJson(advanced)
                : {
                    authMode:
                      provider === "amazon-bedrock" ? "bearer" : authMode,
                    ...(provider === "amazon-bedrock" ? { region } : {}),
                  }),
              ...(provider === "tableau"
                ? { server, site, patName }
                : baseUrl
                  ? { baseUrl }
                  : {}),
            };
      const saved = await command("connections.save", {
        id: initial?.id,
        name,
        provider,
        settings,
        ...(secret
          ? {
              credentials: {
                [provider === "tableau" ? "patValue" : "apiKey"]: secret,
              },
            }
          : {}),
      });
      setSecret("");
      onSaved(saved);
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal
      title={initial ? "Edit connection" : "Add connection"}
      onClose={onClose}
    >
      <div className="stack">
        <ErrorNotice error={error} />
        <Field label="Connection name" required>
          <input
            aria-label="Connection name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Analytics workspace"
          />
        </Field>
        <Field label="Provider">
          <select
            aria-label="Connection provider"
            value={provider}
            disabled={!!initial}
            onChange={(event) => {
              setProvider(event.target.value);
              setAuthMode(
                event.target.value === "amazon-bedrock" ? "bearer" : "api-key",
              );
              setSecret("");
              setBaseUrl("");
            }}
          >
            <option value="tableau">Tableau</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="openrouter">OpenRouter</option>
            <option value="amazon-bedrock">
              AWS Bedrock / company gateway
            </option>
            <option value="typesafe">TypeSafe / Jev</option>
          </select>
        </Field>
        {provider === "tableau" ? (
          <>
            <Field label="Tableau server URL" required>
              <input
                aria-label="Tableau server URL"
                type="url"
                value={server}
                onChange={(event) => setServer(event.target.value)}
                placeholder="https://your-region.online.tableau.com"
              />
            </Field>
            <div className="form-grid">
              <Field label="Site content URL">
                <input
                  aria-label="Tableau site"
                  value={site}
                  onChange={(event) => setSite(event.target.value)}
                  placeholder="your-site"
                />
              </Field>
              <Field label="Personal access token name" required>
                <input
                  aria-label="Personal access token name"
                  value={patName}
                  onChange={(event) => setPatName(event.target.value)}
                />
              </Field>
            </div>
          </>
        ) : provider !== "typesafe" ? (
          <>
            <Field
              label="Authentication"
              help="API keys and bearer tokens are saved credentials. Subscription sign-in is managed separately under Settings, Local harnesses."
            >
              <select
                aria-label="Connection authentication"
                value={provider === "amazon-bedrock" ? "bearer" : authMode}
                onChange={(event) => setAuthMode(event.target.value)}
              >
                {provider !== "amazon-bedrock" && (
                  <option value="api-key">API key</option>
                )}
                <option value="bearer">Bearer token</option>
              </select>
            </Field>
            <Field
              label="API base URL"
              help={
                provider === "amazon-bedrock"
                  ? "Optional company gateway endpoint that supports Amazon Bedrock Converse. Leave blank for the AWS regional endpoint. A gateway using the Anthropic protocol belongs under Anthropic instead."
                  : "Leave blank for the provider endpoint. A company gateway must support this provider's API protocol."
              }
            >
              <input
                aria-label="API base URL"
                type="url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="Provider default"
              />
            </Field>
            {provider === "amazon-bedrock" && (
              <Field
                label="AWS region"
                required
                help="The region used by your Bedrock deployment, for example us-west-2."
              >
                <input
                  aria-label="AWS region"
                  value={region}
                  onChange={(event) => setRegion(event.target.value)}
                  placeholder="us-west-2"
                />
              </Field>
            )}
            <p className="subtle">
              {provider === "amazon-bedrock"
                ? "Select Amazon Bedrock Converse in Run for non-streaming gateway access. OpenCode requires a gateway that also supports streaming. Enter the Bedrock model ID. Gateway model catalogs are not always available; an explicit model ID is supported."
                : "Select this connection for the agent, researcher, or judge in Run. Subscription accounts do not need an API key connection."}
            </p>
          </>
        ) : (
          <p className="subtle">
            Jev uses the official TypeSafe API. The saved key is available only
            to independent judging.
          </p>
        )}
        <Field
          label={
            provider === "tableau"
              ? "Personal access token value"
              : authMode === "bearer" || provider === "amazon-bedrock"
                ? "Bearer token"
                : "API key"
          }
          help="The runtime stores this secret. Saved values are never returned to the browser or included in agent exports."
        >
          <input
            aria-label={
              provider === "tableau"
                ? "Personal access token value"
                : authMode === "bearer" || provider === "amazon-bedrock"
                  ? "Bearer token"
                  : "API key"
            }
            type="password"
            autoComplete="new-password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            placeholder={
              initial?.hasCredentials
                ? "Leave blank to keep the saved credential"
                : "Enter credential"
            }
          />
        </Field>
        {provider === "tableau" && (
          <details className="disclosure">
            <summary>Advanced connection settings</summary>
            <JsonEditor
              label="Advanced connection settings"
              value={advanced}
              onChange={setAdvanced}
              guide={tableauConnectionGuide}
            />
          </details>
        )}
        <footer className="modal-footer">
          {initial && (
            <button
              className="button danger"
              disabled={pending}
              onClick={() => {
                setPending(true);
                void command("connections.delete", { connectionId: initial.id })
                  .then(() => onSaved())
                  .catch(setError)
                  .finally(() => setPending(false));
              }}
            >
              Delete connection
            </button>
          )}
          <button
            className="button primary"
            disabled={pending || !name.trim()}
            onClick={() => {
              void save();
            }}
          >
            {pending ? "Saving..." : "Save connection"}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
