import { HARNESS_LABELS } from "../contracts/harnesses.js";
import { ExternalAgentSettings } from "./external-agents.js";
import { useState, useEffect } from "react";
import type {
  ConnectionRecord,
  RuntimeCatalog,
  WorkspaceView,
} from "../contracts.js";
import { command } from "./api.js";
import { ConnectionEditor } from "./connection-editor.js";
import {
  Empty,
  ErrorNotice,
  Icon,
  JsonView,
  PageHeading,
  Tabs,
  Status,
  SectionIntro,
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
  >(() => {
    const tab =
      typeof window === "undefined"
        ? "connections"
        : window.location.hash.split("/")[2];
    return tab === "external" || tab === "harnesses" ? tab : "connections";
  });
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
  useEffect(() => {
    if (section !== "harnesses") return;
    let current = true;
    setDiscovering(true);
    void command("runtime.discover", {})
      .then((value) => {
        if (current) setRuntime(value);
      })
      .catch((cause) => {
        if (current) setError(cause);
      })
      .finally(() => {
        if (current) setDiscovering(false);
      });
    return () => {
      current = false;
    };
  }, [section]);
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
    <div className="settings-page">
      <PageHeading
        title="Settings"
        description="Manage deployed agents, saved credentials, and local model access."
      >
        {section === "connections" && workspace.connections.length > 0 && (
          <button className="button primary" onClick={() => setEditing("new")}>
            <Icon name="plus" />
            Add connection
          </button>
        )}
      </PageHeading>
      <SectionIntro
        title="Settings"
        description="Set up the services and accounts your agents use. Then select these saved connections when creating a run."
        details="Connections stores Tableau access, model API keys, company gateway tokens, and Jev credentials. Local harnesses shows installed agent software and subscription sign-in. External agents connects an already deployed system by HTTP."
      />
      <Tabs
        label="Settings sections"
        value={section}
        onChange={(value) => {
          setSection(value);
          window.location.hash = `/settings/${value}`;
        }}
        items={[
          { value: "connections", label: "Connections" },
          { value: "harnesses", label: "Subscriptions & harnesses" },
          { value: "external", label: "External agents" },
        ]}
      >
        {section === "external" && <ExternalAgentSettings />}
        <ErrorNotice error={error} />
        {section === "connections" && (
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Saved connections</h2>
                <p>
                  Connect Tableau or save provider credentials. Secret values
                  stay in your operating system credential store.
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
                      <span className="tag">
                        {connection.provider === "typesafe"
                          ? "Jev"
                          : connection.provider === "amazon-bedrock"
                            ? "AWS Bedrock / gateway"
                            : connection.provider}
                      </span>
                    </div>
                    <h3>{connection.name}</h3>
                    <p className="subtle">
                      {connection.provider === "tableau"
                        ? "Tableau MCP access"
                        : connection.settings.authMode === "bearer"
                          ? "Bearer token"
                          : "API key"}
                    </p>
                    <p>
                      {String(
                        connection.settings.server ??
                          connection.settings.baseUrl ??
                          (connection.provider === "typesafe"
                            ? "Jev independent judge"
                            : "Default provider endpoint"),
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
                            ? "Check connection"
                            : connection.provider === "typesafe" ||
                                connection.provider === "amazon-bedrock"
                              ? "Check configuration"
                              : "Refresh models"}
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
                <h2>Subscriptions and agent harnesses</h2>
                <p>
                  A harness runs the agent and its tools. Supported harnesses
                  remain visible even when they are not installed. Subscription
                  sign-in happens in the harness; API credentials belong in
                  Connections.
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
                      <h3>{HARNESS_LABELS[harness.id]}</h3>
                      <p>{harness.version ?? "Version not recorded"}</p>
                    </div>
                    <Status
                      value={harness.available ? "available" : "unavailable"}
                    />
                  </div>
                  {harness.error && <p className="warning">{harness.error}</p>}
                  <p className="subtle">
                    {harness.id === "bedrock"
                      ? "Built-in runtime. Select a saved AWS gateway connection in Run."
                      : harness.authenticated === true
                        ? "Local account detected."
                        : harness.authenticated === false
                          ? "No local account detected."
                          : "Account status is unknown."}{" "}
                    {harness.models.length} models discovered.
                  </p>
                  <details className="disclosure">
                    <summary>Models and authentication</summary>
                    {harness.id === "bedrock" ? (
                      <p className="subtle">
                        Uses the non-streaming Amazon Bedrock Converse API. Save
                        its region, optional gateway URL, and bearer token in
                        Connections. Enter the model ID provided by your gateway
                        administrator.
                      </p>
                    ) : (
                      <p className="subtle">
                        Use{" "}
                        <code>
                          {harness.id === "codex"
                            ? "codex login"
                            : harness.id === "claude"
                              ? "claude auth login"
                              : "opencode auth login"}
                        </code>{" "}
                        in your terminal for a subscribed account, or save a
                        provider API key above. Discovery does not guarantee
                        model entitlement.
                      </p>
                    )}
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
      </Tabs>
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
    </div>
  );
}
