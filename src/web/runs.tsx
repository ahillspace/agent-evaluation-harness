import { savedTarget, targetLabel } from "../contracts/targets.js";
import { useState } from "react";
import type { RunComparison, RunStatus, WorkspaceView } from "../contracts.js";
import { command, useResource } from "./api.js";
import { JudgeSavedAnswers } from "./judge-saved.js";
import { RunOutcomes } from "./run-outcomes.js";
import {
  AssessmentScore,
  AssessmentSelector,
  selectedAssessment,
} from "./assessment-controls.js";
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

export function Runs({
  workspace,
  refresh,
}: {
  workspace: WorkspaceView;
  refresh: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const [judgingRunId, setJudgingRunId] = useState<string | null>(null);
  const [scoreSelections, setScoreSelections] = useState<
    Record<string, string>
  >({});
  const [selected, setSelected] = useState<string[]>([]),
    [query, setQuery] = useState(""),
    [status, setStatus] = useState<RunStatus | "">("");
  const page = useResource(
    "runs.list",
    { limit: 100, offset, search: query, ...(status ? { status } : {}) },
    5000,
  );
  const [error, setError] = useState<unknown>(null),
    [comparison, setComparison] = useState<RunComparison | null>(null),
    [exported, setExported] = useState<{ id: string; value: unknown } | null>(
      null,
    ),
    [saving, setSaving] = useState<string | null>(null),
    [name, setName] = useState(""),
    [pending, setPending] = useState(false);
  const runs = page.data?.runs ?? [];
  return (
    <>
      <PageHeading
        title="Runs"
        description="Start evaluations, review evidence, and compare runs."
      >
        <a href="#/runs/new" className="button primary">
          New run
          <Icon name="plus" />
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
              placeholder="Search all runs by run, bank, or agent"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setOffset(0);
              }}
            />
            <select
              aria-label="Filter run status"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as RunStatus | "");
                setOffset(0);
              }}
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
          <div className="table-scroll runs-table-container">
            <table
              className="results-table"
              role="table"
              aria-label="Saved runs"
            >
              <thead role="rowgroup">
                <tr role="row">
                  <th scope="col" role="columnheader">
                    <span className="sr-only">Select</span>
                  </th>
                  <th scope="col" role="columnheader">
                    Run
                  </th>
                  <th scope="col" role="columnheader">
                    Agent
                  </th>
                  <th scope="col" role="columnheader">
                    Status
                  </th>
                  <th scope="col" role="columnheader">
                    Answers
                  </th>
                  <th scope="col" role="columnheader">
                    Saved score
                  </th>
                  <th scope="col" role="columnheader">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                {runs.map((run) => (
                  <tr key={run.id} role="row">
                    <td className="results-selection" role="cell">
                      <span className="results-field-label" aria-hidden="true">
                        Compare
                      </span>
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
                    <td className="results-identity" role="cell">
                      <a
                        className="run-link"
                        href={`#/runs/${run.id}${run.researchSessionId ? `?session=${run.researchSessionId}` : ""}`}
                      >
                        {run.name}
                      </a>
                      <small>
                        {run.bankName} · {date(run.createdAt)}
                      </small>
                    </td>
                    <td role="cell">
                      <span className="results-field-label" aria-hidden="true">
                        Agent
                      </span>
                      <span>
                        {run.targetKind === "external"
                          ? run.targetName
                          : `${run.harness} / ${run.model}`}
                      </span>
                      <small>
                        {run.targetKind === "external"
                          ? "External agent"
                          : run.harness}
                      </small>
                    </td>
                    <td role="cell">
                      <span className="results-field-label" aria-hidden="true">
                        Status
                      </span>
                      <Status value={run.status} />
                    </td>
                    <td className="mono" role="cell">
                      <span className="results-field-label" aria-hidden="true">
                        Answers
                      </span>
                      <RunOutcomes {...run} />
                    </td>
                    <td className="mono" role="cell">
                      <span className="results-field-label" aria-hidden="true">
                        Saved score
                      </span>
                      <AssessmentSelector
                        runId={run.id}
                        passes={run.assessmentPasses ?? []}
                        selectedId={
                          scoreSelections[run.id] ??
                          run.selectedAssessmentPassId
                        }
                        label={`Saved score for ${run.name}`}
                        onSaved={(id) => {
                          setScoreSelections((current) => ({
                            ...current,
                            [run.id]: id,
                          }));
                          page.refresh();
                          refresh();
                        }}
                      />
                      <AssessmentScore
                        pass={selectedAssessment(
                          run.assessmentPasses ?? [],
                          scoreSelections[run.id] ??
                            run.selectedAssessmentPassId,
                        )}
                      />
                    </td>
                    <td role="cell">
                      <span className="results-field-label" aria-hidden="true">
                        Actions
                      </span>
                      <div className="row-actions">
                        <a
                          href={`#/runs/new?source=${run.id}`}
                          title="Reuse frozen configuration"
                        >
                          Reuse
                        </a>
                        <details className="result-actions-menu">
                          <summary aria-label={`More actions for ${run.name}`}>
                            More
                          </summary>
                          <div className="result-actions-list">
                            <button
                              disabled={!run.completed}
                              title={
                                !run.completed
                                  ? "Record at least one completed answer first."
                                  : "Create another score from recorded answers without running the agent again."
                              }
                              onClick={() => setJudgingRunId(run.id)}
                            >
                              Score saved answers
                            </button>
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
                        </details>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!runs.length && (
            <p className="panel-body subtle" role="status">
              {!page.data && !page.error
                ? "Loading runs..."
                : page.error
                  ? "Runs could not be loaded."
                  : "No runs match these filters."}
            </p>
          )}
          <div className="pagination">
            <span>
              {runs.length ? offset + 1 : 0}-
              {runs.length ? offset + runs.length : 0} of{" "}
              {page.data?.total ?? 0} matching runs
            </span>
            <div className="actions">
              <button
                className="button secondary"
                disabled={offset === 0 || !page.data}
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
        <Empty title="Your evaluation evidence starts here">
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
          <div className="panel-body">
            {workspace.blueprints.map((blueprint) => (
              <article className="history-row" key={blueprint.id}>
                <div>
                  <strong>{blueprint.name}</strong>
                  <p>{targetLabel(savedTarget(blueprint))}</p>
                </div>
                <div className="actions">
                  <a
                    className="button secondary"
                    href={`#/runs/new?blueprint=${blueprint.id}`}
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
          : "Review the warnings when comparing these runs."}
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
              <th>Selected score</th>
              <th>Answers</th>
              <th>Repetitions</th>
            </tr>
          </thead>
          <tbody>
            {value.rows.map((row) => (
              <tr key={row.runId}>
                <td>
                  <a href={`#/runs/${row.runId}`}>{row.name}</a>
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
                  <strong>
                    {row.assessmentPass?.name ?? "No saved score"}
                  </strong>
                  <AssessmentScore pass={row.assessmentPass} />
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
              assessmentPassId,
            }) => ({
              runId,
              bankRevisionId,
              questionDigest,
              evaluatorRevisionId,
              assessmentPassId,
            }),
          )}
        />
      </details>
    </div>
  );
}
