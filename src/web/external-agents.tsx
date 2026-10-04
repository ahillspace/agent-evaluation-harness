import { useState } from "react";
import type {
  ExternalTargetConfig,
  ExternalTargetRecord,
  TargetOutput,
} from "../contracts.js";
import { sameTarget } from "../contracts/targets.js";
import { httpTargetSchema } from "../contracts/http-target.js";
import { command, useResource } from "./api.js";
import { Answer } from "./answer.js";
import { ErrorNotice, Field, Help } from "./ui.js";

export function ExternalAgentEditor({
  record,
  initialTarget,
  onSaved,
}: {
  record?: ExternalTargetRecord;
  initialTarget?: ExternalTargetConfig;
  onSaved: (record: ExternalTargetRecord) => void;
}) {
  const initial = record?.target ?? initialTarget;
  const config = httpTargetSchema.safeParse(initial?.configuration);
  const original = config.success ? config.data : undefined;
  const [name, setName] = useState(initial?.name ?? "External agent");
  const [endpoint, setEndpoint] = useState(original?.endpoint ?? "");
  const [auth, setAuth] = useState(original?.authentication.kind ?? "none");
  const [header, setHeader] = useState(
    original?.authentication.kind === "api-key"
      ? original.authentication.header
      : "X-API-Key",
  );
  const [credential, setCredential] = useState("");
  const [body, setBody] = useState(
    JSON.stringify(
      original?.body ?? { question: null, context: null, answerFormat: null },
      null,
      2,
    ),
  );
  const [bindings, setBindings] = useState(
    JSON.stringify(
      original?.bindings ?? [
        { pointer: "/question", source: "question" },
        { pointer: "/context", source: "context" },
        { pointer: "/answerFormat", source: "answerFormat" },
      ],
      null,
      2,
    ),
  );
  const [answer, setAnswer] = useState(original?.answerPointer ?? "/answer");
  const [headers, setHeaders] = useState(
    JSON.stringify(original?.headers ?? {}, null, 2),
  );
  const [label, setLabel] = useState(original?.deploymentLabel ?? "");
  const [sample, setSample] = useState(
    "Describe what this agent can help with.",
  );
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<unknown>();
  const [sampleResult, setSampleResult] = useState<TargetOutput>();
  const [saved, setSaved] = useState<ExternalTargetRecord | undefined>(record);
  const questionBinding = (() => {
    try {
      return (
        JSON.parse(bindings) as Array<{ source: string; pointer: string }>
      ).find((item) => item.source === "question")?.pointer;
    } catch {
      return undefined;
    }
  })();
  const questionField = questionBinding?.match(/^\/([^/~]+)$/)?.[1];
  const setQuestionField = (field: string) => {
    if (!field || /[~/]/.test(field)) return;
    try {
      const template = JSON.parse(body) as Record<string, unknown>;
      if (
        !questionField ||
        Array.isArray(template) ||
        !template ||
        typeof template !== "object"
      )
        throw new Error("Use advanced bindings for this request structure.");
      if (field !== questionField && Object.hasOwn(template, field))
        throw new Error("That request field already exists.");
      delete template[questionField];
      template[field] = null;
      const mapped = (
        JSON.parse(bindings) as Array<{ source: string; pointer: string }>
      ).map((item) =>
        item.source === "question" ? { ...item, pointer: `/${field}` } : item,
      );
      setBody(JSON.stringify(template, null, 2));
      setBindings(JSON.stringify(mapped, null, 2));
      setError(undefined);
    } catch (cause) {
      setError(cause);
    }
  };
  const configuration = () => {
    const current = httpTargetSchema.safeParse(saved?.target.configuration);
    const authentication = current.success
      ? current.data.authentication
      : original?.authentication;
    const reference =
      authentication?.kind !== "none"
        ? authentication?.credentialReference
        : undefined;
    return httpTargetSchema.parse({
      endpoint,
      authentication:
        auth === "none"
          ? { kind: "none" }
          : {
              kind: auth,
              ...(auth === "api-key" ? { header } : {}),
              credentialReference: reference ?? "unbound",
            },
      body: JSON.parse(body),
      bindings: JSON.parse(bindings),
      answerPointer: answer,
      headers: JSON.parse(headers),
      ...(label ? { deploymentLabel: label } : {}),
    });
  };
  const target = (): ExternalTargetConfig => ({
    kind: "external",
    adapterId: "http",
    adapterVersion: 1,
    name,
    configuration: configuration(),
  });
  const action = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await operation();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    const result = await command("targets.save", {
      id: saved?.id,
      name,
      target: target(),
      ...(credential ? { credential } : {}),
    });
    setCredential("");
    setSaved(result);
    onSaved(result);
    return result;
  };
  return (
    <div className="stack external-agent-editor">
      <ErrorNotice error={error} />
      <Field label="Agent name" required>
        <input
          aria-label="External agent name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field
        label="Endpoint URL"
        required
        help="A JSON POST endpoint that returns a final answer. Use HTTPS, or HTTP for a loopback development endpoint."
      >
        <input
          aria-label="Endpoint URL"
          type="url"
          placeholder="https://example.com/agent"
          value={endpoint}
          onChange={(event) => setEndpoint(event.target.value)}
        />
      </Field>
      <Field label="Authentication">
        <select
          aria-label="Endpoint authentication"
          value={auth}
          onChange={(event) => setAuth(event.target.value as typeof auth)}
        >
          <option value="none">None</option>
          <option value="bearer">Bearer token</option>
          <option value="api-key">API key header</option>
        </select>
      </Field>
      {auth === "api-key" && (
        <Field label="API key header">
          <input
            aria-label="API key header"
            value={header}
            onChange={(event) => setHeader(event.target.value)}
          />
        </Field>
      )}
      {auth !== "none" && (
        <Field
          label="Credential"
          help="Stored in your operating system credential store. Enter it again when changing the endpoint or request configuration."
        >
          <input
            aria-label="Endpoint credential"
            type="password"
            autoComplete="new-password"
            value={credential}
            placeholder={
              record?.hasCredentials || saved?.hasCredentials
                ? "Saved credential; leave blank to keep"
                : "Enter credential"
            }
            onChange={(event) => setCredential(event.target.value)}
          />
        </Field>
      )}
      <Field
        label="Question field"
        help="The top-level JSON field that receives the question, such as question, prompt, or message. Use advanced bindings for nested fields."
      >
        <input
          aria-label="Question field"
          value={questionField ?? "Nested mapping: use advanced settings"}
          disabled={!questionField}
          onChange={(event) => setQuestionField(event.target.value)}
        />
      </Field>
      <Field
        label="Answer field"
        help="JSON Pointer to the returned answer, for example /answer or /result/text. Leave empty to evaluate the complete JSON response."
      >
        <input
          aria-label="Answer field"
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
        />
      </Field>
      <details>
        <summary>Advanced request settings</summary>
        <div className="stack">
          <Field
            label="Deployment label"
            help="Your reference label for the remote deployment. The harness cannot freeze or verify its implementation."
          >
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </Field>
          <Field
            label="Request body template"
            help="JSON values and existing slots. The bindings below replace those slots with public question data."
          >
            <textarea
              aria-label="Request body template"
              rows={7}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </Field>
          <Field
            label="Public input bindings"
            help="Map a JSON Pointer to question, context, answerFormat, runId, questionId, repetition, or attemptId. No scripts or expected answers are available."
          >
            <textarea
              aria-label="Public input bindings"
              rows={7}
              value={bindings}
              onChange={(event) => setBindings(event.target.value)}
            />
          </Field>
          <Field
            label="Non-secret headers"
            help="A JSON object. Configure authentication above; credentials cannot go here."
          >
            <textarea
              aria-label="Non-secret headers"
              rows={3}
              value={headers}
              onChange={(event) => setHeaders(event.target.value)}
            />
          </Field>
        </div>
      </details>
      <Field
        label="Sample question"
        help="Preview does not contact the endpoint. Send sample request invokes the remote agent and can cause billable work."
      >
        <textarea
          aria-label="Sample question"
          rows={2}
          value={sample}
          onChange={(event) => setSample(event.target.value)}
        />
      </Field>
      <div className="row wrap">
        <button
          className="button"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              setSampleResult(undefined);
              setPreview(
                await command("targets.preview", {
                  target: target(),
                  question: { id: "sample", text: sample, tags: [] },
                }),
              );
            })
          }
        >
          Preview request
        </button>
        <button
          className="button primary"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              await save();
            })
          }
        >
          Save external agent
        </button>
        <button
          className="button"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              const result = await save();
              const response = await command("targets.sample", {
                target: result.target,
                question: { id: "sample", text: sample, tags: [] },
              });
              setSampleResult(response);
              setPreview(response.transport);
            })
          }
        >
          Send sample request
        </button>
      </div>
      {sampleResult && (
        <div className="answer-block">
          <div className="eyebrow">Sample answer received</div>
          <Answer value={sampleResult.answer} />
          <p className="subtle">
            The endpoint returned an answer. Samples are not graded.
          </p>
        </div>
      )}
      {preview !== undefined && (
        <details open={!sampleResult}>
          <summary>Request or response details</summary>
          <pre className="code-block">{JSON.stringify(preview, null, 2)}</pre>
        </details>
      )}
      <p className="subtle">
        Internal prompts, models, tools, and activity are managed by the
        external system.
      </p>
    </div>
  );
}

export function ExternalAgentPicker({
  target,
  onChange,
}: {
  target?: ExternalTargetConfig;
  onChange: (target: ExternalTargetConfig) => void;
}) {
  const resource = useResource("targets.list", {});
  const [editing, setEditing] = useState(false);
  const records = resource.data ?? [];
  const selected = records.find((item) => sameTarget(item.target, target));
  return (
    <div className="stack">
      <ErrorNotice error={resource.error} />
      <Field label="External agent" required>
        <select
          aria-label="External agent"
          value={selected?.id ?? ""}
          onChange={(event) => {
            const record = records.find(
              (item) => item.id === event.target.value,
            );
            if (record) {
              onChange(record.target);
              setEditing(false);
            }
          }}
        >
          <option value="">
            {target
              ? `${target.name} (saved run configuration)`
              : "Choose an external agent"}
          </option>
          {records.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </Field>
      {target && (
        <div className="notice">
          <strong>{target.name}</strong>
          <p className="subtle">
            Your external system controls this agent. The harness sends
            questions and evaluates the answers.
          </p>
          <Help label="External agent ownership">
            System prompts, models, tools, and research are controlled outside
            this app. Timeout or cancellation stops local waiting and does not
            confirm remote cancellation.
          </Help>
          <pre className="code-block">
            {String(
              (target.configuration as { endpoint?: string }).endpoint ?? "",
            )}
          </pre>
        </div>
      )}
      <button className="button" onClick={() => setEditing(!editing)}>
        {editing
          ? "Close editor"
          : target
            ? "Edit or add external agent"
            : "Add external agent"}
      </button>
      {editing && (
        <ExternalAgentEditor
          record={selected}
          initialTarget={target}
          onSaved={(record) => {
            onChange(record.target);
            resource.refresh();
          }}
        />
      )}
    </div>
  );
}

export function ExternalAgentSettings() {
  const resource = useResource("targets.list", {});
  const [editing, setEditing] = useState<
    ExternalTargetRecord | null | undefined
  >();
  const [error, setError] = useState<unknown>();
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>External agents</h2>
        <button className="button" onClick={() => setEditing(null)}>
          Add external agent
        </button>
      </div>
      <div className="panel-body stack">
        <p className="subtle">
          Evaluate deployed agents through a JSON HTTP endpoint. Internal
          configuration and observability stay with the external system.
        </p>
        <p className="subtle">
          Removing an endpoint keeps credential versions used by saved runs and
          samples so those snapshots can still resolve authentication.
        </p>
        <ErrorNotice error={error ?? resource.error} />
        {(resource.data ?? []).map((record) => (
          <div className="row between" key={record.id}>
            <div>
              <strong>{record.name}</strong>
              <p className="subtle">HTTP endpoint</p>
            </div>
            <div className="row">
              <button className="button" onClick={() => setEditing(record)}>
                Edit
              </button>
              <button
                className="button"
                onClick={() => {
                  void command("targets.delete", { targetId: record.id })
                    .then(() => resource.refresh())
                    .catch(setError);
                }}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        {editing !== undefined && (
          <ExternalAgentEditor
            key={editing?.id ?? "new"}
            record={editing ?? undefined}
            onSaved={() => resource.refresh()}
          />
        )}
      </div>
    </section>
  );
}
