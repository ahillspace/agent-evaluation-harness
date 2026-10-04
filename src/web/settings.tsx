import { ExternalAgentSettings } from "./external-agents.js";
import { useState } from "react";
import type {
  ConnectionRecord,
  Json,
  RuntimeCatalog,
  WorkspaceView,
} from "../contracts.js";
import { command } from "./api.js";
import { objectJson } from "./drafts.js";
import {
  Empty,
  ErrorNotice,
  Field,
  Icon,
  JsonView,
  Modal,
  PageHeading,
  Status,
} from "./ui.js";

export function Settings({
  workspace,
  refresh,
}: {
  workspace: WorkspaceView;
  refresh: () => void;
}) {
  const [section, setSection] = useState<
    "external" | "connections" | "harnesses"
  >("external");
  const [runtime, setRuntime] = useState<RuntimeCatalog | undefined>(
    workspace.runtime,
  );
  const [editing, setEditing] = useState<ConnectionRecord | "new" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [testing, setTesting] = useState("");
  const [testResults, setTestResults] = useState<Record<string, unknown>>({});
  const [discovering, setDiscovering] = useState(false);
  const discover = async () => {
    setDiscovering(true);
    try {
      setRuntime(await command("runtime.discover", {}));
    } catch (cause) {
      setError(cause);
    } finally {
      setDiscovering(false);
    }
  };
  const test = async (id: string) => {
    setTesting(id);
    setError(null);
    try {
      const result = await command("connections.test", { connectionId: id });
      setTestResults((values) => ({ ...values, [id]: result }));
    } catch (cause) {
      setError(cause);
    } finally {
      setTesting("");
    }
  };
  return (
    <>
      <PageHeading
        eyebrow="Workspace settings"
        title="Agents & connections"
        description="Connect your data, choose authentication, and inspect the tools available to your agents."
      >
        {section === "connections" && (
          <button className="button primary" onClick={() => setEditing("new")}>
            <Icon name="plus" />
            Add connection
          </button>
        )}
      </PageHeading>
      <div className="tabs" role="tablist" aria-label="Settings sections">
        {(
          [
            ["external", "External agents"],
            ["connections", "Connections"],
            ["harnesses", "Local harnesses"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            role="tab"
            aria-selected={section === value}
            onClick={() => setSection(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {section === "external" && <ExternalAgentSettings />}
      <ErrorNotice error={error} />
      {section === "connections" && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Saved connections</h2>
              <p>
                Only credential presence is returned. Stored secret values never
                appear here.
              </p>
            </div>
          </div>
          {workspace.connections.length ? (
            <div className="connection-grid">
              {workspace.connections.map((connection) => (
                <article className="connection-card" key={connection.id}>
                  <div className="row">
                    <span className="connection-symbol">
                      <Icon
                        name={
                          connection.provider === "tableau" ? "bank" : "agent"
                        }
                        size={24}
                      />
                    </span>
                    <span className="tag">{connection.provider}</span>
                  </div>
                  <h3>{connection.name}</h3>
                  <p>
                    {String(
                      connection.settings.server ??
                        connection.settings.baseUrl ??
                        "Local provider connection",
                    )}
                  </p>
                  <span className="credential-note">
                    <Icon name="shield" size={14} />
                    {connection.hasCredentials
                      ? "Credentials saved"
                      : "No credentials saved"}
                  </span>
                  <div className="actions">
                    <button
                      className="button secondary"
                      disabled={!!testing}
                      onClick={() => {
                        void test(connection.id);
                      }}
                    >
                      {testing === connection.id
                        ? "Testing..."
                        : connection.provider === "tableau"
                          ? "Test & discover tools"
                          : "Test & discover models"}
                    </button>
                    <button
                      className="text-button"
                      onClick={() => setEditing(connection)}
                    >
                      Edit
                    </button>
                  </div>
                  {testResults[connection.id] !== undefined && (
                    <details open className="disclosure">
                      <summary>Connection discovery</summary>
                      <JsonView value={testResults[connection.id]} />
                    </details>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <Empty
              title="Connect your first data source"
              action={
                <button
                  className="button primary"
                  onClick={() => setEditing("new")}
                >
                  Add connection
                </button>
              }
            >
              Save a Tableau connection or a provider API key. Subscribed
              harness accounts use the local sign-in state.
            </Empty>
          )}
        </section>
      )}
      {section === "harnesses" && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Installed model harnesses</h2>
              <p>
                Discovery reads installed tools and their actual model catalogs.
              </p>
            </div>
            <button
              className="button secondary"
              disabled={discovering}
              onClick={() => {
                void discover();
              }}
            >
              {discovering ? "Discovering..." : "Refresh discovery"}
            </button>
          </div>
          <div className="panel-body stack">
            {runtime?.harnesses.map((harness) => (
              <article className="harness-card" key={harness.id}>
                <div className="row">
                  <div>
                    <h3>{harness.id}</h3>
                    <p>{harness.version ?? "Version not recorded"}</p>
                  </div>
                  <Status
                    value={harness.available ? "available" : "unavailable"}
                  />
                </div>
                {harness.error && <p className="warning">{harness.error}</p>}
                <p className="subtle">
                  {harness.authenticated === true
                    ? "Local account detected."
                    : harness.authenticated === false
                      ? "No local account detected."
                      : "Account status is unknown."}{" "}
                  {harness.models.length} models discovered.
                </p>
                <details className="disclosure">
                  <summary>Models and authentication</summary>
                  <p className="subtle">
                    Use{" "}
                    <code>
                      {harness.id === "codex"
                        ? "codex login"
                        : "opencode auth login"}
                    </code>{" "}
                    in your terminal for a subscribed account, or save a
                    provider API key above. Discovery does not guarantee model
                    entitlement.
                  </p>
                  {harness.models.length ? (
                    <div className="model-list">
                      {harness.models.map((model) => (
                        <div key={model.id}>
                          <strong>{model.name}</strong>
                          <code>{model.id}</code>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p>
                      No model catalog is available. Check installation and
                      authentication, then refresh discovery.
                    </p>
                  )}
                </details>
              </article>
            ))}
            {!runtime && (
              <p className="subtle">
                {discovering
                  ? "Discovering installed harnesses..."
                  : "Select Refresh discovery to inspect local harnesses and models."}
              </p>
            )}
          </div>
        </section>
      )}
      {editing && (
        <ConnectionEditor
          connection={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </>
  );
}

export function ConnectionEditor({
  connection,
  onClose,
  onSaved,
}: {
  connection: ConnectionRecord | "new";
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial = connection === "new" ? undefined : connection;
  const [name, setName] = useState(initial?.name ?? "");
  const [provider, setProvider] = useState(initial?.provider ?? "tableau");
  const [server, setServer] = useState(String(initial?.settings.server ?? ""));
  const [site, setSite] = useState(String(initial?.settings.site ?? ""));
  const [patName, setPatName] = useState(
    String(initial?.settings.patName ?? ""),
  );
  const [baseUrl, setBaseUrl] = useState(
    String(initial?.settings.baseUrl ?? ""),
  );
  const [secret, setSecret] = useState("");
  const [advanced, setAdvanced] = useState(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(initial?.settings ?? {}).filter(
          ([key]) => !["server", "site", "patName", "baseUrl"].includes(key),
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
              ...objectJson(advanced),
              ...(provider === "tableau"
                ? { server, site, patName }
                : baseUrl
                  ? { baseUrl }
                  : {}),
            };
      await command("connections.save", {
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
      onSaved();
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
            onChange={(event) => setProvider(event.target.value)}
          >
            <option value="tableau">Tableau</option>
            <option value="openai">OpenAI API key</option>
            <option value="anthropic">Anthropic API key</option>
            <option value="openrouter">OpenRouter API key</option>
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
          <Field
            label="API base URL"
            help="Leave blank to use the provider default. A custom endpoint must support the selected provider protocol."
          >
            <input
              aria-label="API base URL"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="Provider default"
            />
          </Field>
        ) : (
          <p className="subtle">
            Jev uses the official TypeSafe API. The saved key is available only
            to independent judging.
          </p>
        )}
        <Field
          label={
            provider === "tableau" ? "Personal access token value" : "API key"
          }
          help="The runtime stores this secret. Saved values are never returned to the browser or included in agent exports."
        >
          <input
            aria-label={
              provider === "tableau" ? "Personal access token value" : "API key"
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
        {provider !== "typesafe" && (
          <details className="disclosure">
            <summary>Advanced connection settings</summary>
            <p className="subtle">
              JSON object for provider options. Tableau supports mcpCommand and
              mcpArgs. Put secrets in the credential field above.
            </p>
            <textarea
              aria-label="Advanced connection settings"
              className="code-input"
              rows={6}
              value={advanced}
              onChange={(event) => setAdvanced(event.target.value)}
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
                  .then(onSaved)
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
