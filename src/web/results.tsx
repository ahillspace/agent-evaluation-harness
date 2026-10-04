import { savedTarget, targetLabel } from "../contracts/targets.js";
import { useState } from "react";
import type { RunComparison, WorkspaceView } from "../contracts.js";
import { command, useResource } from "./api.js";
import { JudgeSavedAnswers } from "./judge-saved.js";
import { RunAccuracy, RunOutcomes } from "./run-outcomes.js";
import {
  DownloadButton,
  Empty,
  ErrorNotice,
  Field,
  Icon,
  JsonView,
  Modal,
  PageHeading,
  Status,
  date,
} from "./ui.js";

export function Results({
  workspace,
  refresh,
}: {
  workspace: WorkspaceView;
  refresh: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const [judgingRunId, setJudgingRunId] = useState<string | null>(null);
  const page = useResource("runs.list", { limit: 100, offset }, 5000);
  const [selected, setSelected] = useState<string[]>([]),
    [query, setQuery] = useState(""),
    [status, setStatus] = useState("");
  const [error, setError] = useState<unknown>(null),
    [comparison, setComparison] = useState<RunComparison | null>(null),
    [exported, setExported] = useState<{ id: string; value: unknown } | null>(
      null,
    ),
    [saving, setSaving] = useState<string | null>(null),
    [name, setName] = useState(""),
    [pending, setPending] = useState(false);
  const runs = (page.data?.runs ?? workspace.runs).filter(
    (run) =>
      `${run.name} ${run.bankName} ${run.target ? targetLabel(run.target) : run.model}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (!status || run.status === status),
  );
  return (
    <>
      <PageHeading
        eyebrow="Evidence library"
        title="Results"
        description="Inspect saved runs, compare evidence, and reuse tested configuration."
      >
        <a className="button primary" href="#/run">
          <Icon name="plus" size={16} />
          New run
        </a>
      </PageHeading>
      <ErrorNotice error={error ?? page.error} />
      {judgingRunId && (
        <JudgeSavedAnswers
          runId={judgingRunId}
          workspace={workspace}
          onClose={() => setJudgingRunId(null)}
          onSaved={() => {
            refresh();
            page.refresh();
          }}
        />
      )}
      {workspace.runs.length ? (
        <section className="panel">
          <div className="results-toolbar">
            <input
              aria-label="Search runs"
              placeholder="Filter this page by run, bank, or agent"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <select
              aria-label="Filter run status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="">All statuses</option>
              {[
                "queued",
                "running",
                "paused",
                "halted",
                "completed",
                "failed",
                "cancelled",
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
            <button
              className="button secondary"
              disabled={selected.length < 2 || pending}
              onClick={() => {
                setPending(true);
                void command("runs.compare", {
                  runIds: selected,
                })
                  .then(setComparison)
                  .catch(setError)
                  .finally(() => setPending(false));
              }}
            >
              {pending
                ? "Comparing..."
                : `Compare${selected.length ? ` (${selected.length})` : ""}`}
            </button>
          </div>
          <div className="table-scroll">
            <table className="results-table">
              <thead>
                <tr>
                  <th>
                    <span className="sr-only">Select</span>
                  </th>
                  <th>Run</th>
                  <th>Agent</th>
                  <th>Status</th>
                  <th>Answers</th>
                  <th>Deterministic accuracy</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${run.name} for comparison`}
                        checked={selected.includes(run.id)}
                        onChange={(event) =>
                          setSelected((ids) =>
                            event.target.checked
                              ? [...ids, run.id]
                              : ids.filter((id) => id !== run.id),
                          )
                        }
                      />
                    </td>
                    <td>
                      <a
                        className="run-link"
                        href={`#/observe/${run.id}${run.researchSessionId ? `?session=${run.researchSessionId}` : ""}`}
                      >
                        {run.name}
                      </a>
                      <small>
                        {run.bankName} · {date(run.createdAt)}
                      </small>
                    </td>
                    <td>
                      <span>
                        {run.target ? targetLabel(run.target) : run.model}
                      </span>
                      <small>
                        {run.target?.kind === "external"
                          ? "External agent"
                          : run.harness}
                      </small>
                    </td>
                    <td>
                      <Status value={run.status} />
                    </td>
                    <td className="mono">
                      <RunOutcomes {...run} />
                    </td>
                    <td className="mono">
                      <RunAccuracy {...run} />
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          disabled={!run.completed}
                          onClick={() => setJudgingRunId(run.id)}
                        >
                          Judge saved answers
                        </button>
                        <a
                          href={`#/run?source=${run.id}`}
                          title="Reuse frozen configuration"
                        >
                          Reuse
                        </a>
                        <button
                          onClick={() => {
                            setSaving(run.id);
                            setName(`${run.name} configuration`);
                          }}
                        >
                          Save blueprint
                        </button>
                        <button
                          onClick={() => {
                            void command("runs.export-target", {
                              runId: run.id,
                            })
                              .then((value) =>
                                setExported({ id: run.id, value }),
                              )
                              .catch(setError);
                          }}
                        >
                          Export JSON
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!runs.length && (
            <p className="panel-body subtle">No runs match these filters.</p>
          )}
          <div className="pagination">
            <span>
              {offset + 1}-
              {Math.min(offset + 100, page.data?.total ?? workspace.totalRuns)}{" "}
              of {page.data?.total ?? workspace.totalRuns} saved runs
            </span>
            <div className="actions">
              <button
                className="button secondary"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 100))}
              >
                Previous
              </button>
              <button
                className="button secondary"
                disabled={page.data?.nextOffset == null}
                onClick={() => setOffset(page.data?.nextOffset ?? offset)}
              >
                Next
              </button>
            </div>
          </div>
        </section>
      ) : (
        <Empty
          title="Your evaluation evidence starts here"
          action={
            <a href="#/run" className="button primary">
              Set up a run
              <Icon name="arrow" />
            </a>
          }
        >
          Saved runs include their frozen configuration, activity, answers, and
          assessments. Every saved run supports agent JSON export.
        </Empty>
      )}
      {workspace.blueprints.length > 0 && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Saved blueprints</h2>
              <p>
                Reuse agent settings, repetition count, and evaluation limits.
              </p>
            </div>
          </div>
          <div className="blueprint-grid">
            {workspace.blueprints.map((blueprint) => (
              <article className="blueprint-card" key={blueprint.id}>
                <Icon name="agent" size={22} />
                <h3>{blueprint.name}</h3>
                <p>{targetLabel(savedTarget(blueprint))}</p>
                <div className="actions">
                  <a
                    className="button secondary"
                    href={`#/run?blueprint=${blueprint.id}`}
                  >
                    Use blueprint
                  </a>
                  <button
                    className="text-button danger"
                    onClick={() => {
                      void command("blueprints.delete", {
                        blueprintId: blueprint.id,
                      })
                        .then(refresh)
                        .catch(setError);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
      {comparison !== null && (
        <Modal title="Compare saved runs" onClose={() => setComparison(null)}>
          <p className="subtle">
            Comparison uses saved evidence. Different question sets or
            evaluation bases require careful interpretation.
          </p>
          <Comparison value={comparison} />
        </Modal>
      )}
      {exported && (
        <Modal
          title="Export target configuration"
          onClose={() => setExported(null)}
        >
          <p className="subtle">
            Frozen known target settings and credential placeholders. External
            exports describe the endpoint invocation, not the remote agent
            implementation.
          </p>
          <DownloadButton
            filename={`${exported.id}-agent.json`}
            value={exported.value}
          >
            Download target JSON
          </DownloadButton>
          <JsonView value={exported.value} />
        </Modal>
      )}
      {saving && (
        <Modal title="Save reusable blueprint" onClose={() => setSaving(null)}>
          <Field label="Blueprint name">
            <input
              aria-label="Blueprint name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <button
            className="button primary"
            disabled={pending || !name.trim()}
            onClick={() => {
              setPending(true);
              void command("blueprints.save", { name, runId: saving })
                .then(() => {
                  setSaving(null);
                  refresh();
                })
                .catch(setError)
                .finally(() => setPending(false));
            }}
          >
            {pending ? "Saving..." : "Save blueprint"}
          </button>
        </Modal>
      )}
    </>
  );
}

function Comparison({ value }: { value: RunComparison }) {
  return (
    <div className="stack">
      <div className={`notice ${value.comparable ? "" : "error"}`}>
        {value.comparable
          ? "These runs share a compatible comparison basis."
          : "These runs have different evaluation bases."}
      </div>
      {value.warnings.map((warning) => (
        <p className="warning" key={warning}>
          {warning}
        </p>
      ))}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Agent</th>
              <th>Deterministic accuracy</th>
              <th>Answers</th>
              <th>Repetitions</th>
            </tr>
          </thead>
          <tbody>
            {value.rows.map((row) => (
              <tr key={row.runId}>
                <td>
                  <a href={`#/observe/${row.runId}`}>{row.name}</a>
                  <small>{row.status}</small>
                </td>
                <td>
                  {row.target ? targetLabel(row.target) : row.model}
                  <small>
                    {row.target?.kind === "external"
                      ? "External agent"
                      : row.harness}
                  </small>
                </td>
                <td>
                  <RunAccuracy {...row} />
                </td>
                <td>
                  <RunOutcomes {...row} />
                </td>
                <td>{row.repetitions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="disclosure">
        <summary>Comparison basis and record IDs</summary>
        <JsonView
          value={value.rows.map(
            ({
              runId,
              bankRevisionId,
              questionDigest,
              evaluatorRevisionId,
              scoreSetId,
            }) => ({
              runId,
              bankRevisionId,
              questionDigest,
              evaluatorRevisionId,
              scoreSetId,
            }),
          )}
        />
      </details>
    </div>
  );
}
