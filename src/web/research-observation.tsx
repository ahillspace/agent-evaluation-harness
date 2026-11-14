import { useState } from "react";
import type { Control } from "../contracts.js";
import { command, navigate, useResource } from "./api.js";
import { useObservation } from "./observation-stream.js";
import { EventList } from "./observation-events.js";
import {
  ControlButtons,
  ErrorNotice,
  Field,
  Status,
  JsonView,
  Modal,
  SectionIntro,
} from "./ui.js";

export function ResearchPanel({
  sessionId,
  selectedRunId,
}: {
  sessionId: string;
  selectedRunId: string;
}) {
  const resource = useObservation("research.get", { sessionId });
  const [pending, setPending] = useState<string | null>(null),
    [error, setError] = useState<unknown>(null);
  const [selectedTurn, setSelectedTurn] = useState<{
    sessionId: string;
    index: number;
  } | null>(null);
  if (!resource.data) return <ErrorNotice error={resource.error} />;
  const { session, allowedActions, events } = resource.data;
  const researchRuns = session.runIds.map((id, index) => {
    const name = index === 0 ? "Baseline" : `Candidate ${index}`;
    return {
      id,
      name,
      label: [
        name,
        ...(id === session.bestRunId ? ["retained"] : []),
        ...(id === session.currentRunId ? ["current"] : []),
      ].join(" · "),
    };
  });
  const selectedRun = researchRuns.find((run) => run.id === selectedRunId);
  const retainedRun = researchRuns.find((run) => run.id === session.bestRunId);
  return (
    <section className="panel research-panel">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">Research session</div>
          <h2>{session.name}</h2>
          <p>
            <Status value={session.status} />
          </p>
        </div>
        <ControlButtons
          actions={allowedActions}
          pending={pending}
          onAction={(action) => {
            setPending(action);
            void command("research.control", {
              sessionId,
              action: action as Control,
            })
              .then(resource.refresh)
              .catch(setError)
              .finally(() => setPending(null));
          }}
        />
      </div>
      <ErrorNotice error={error ?? resource.error ?? session.error} />
      <div className="panel-body">
        <SectionIntro
          title="Research observation"
          description="Watch the researcher propose changes and compare candidate agents."
          details="The baseline runs first. Researcher intent records recommendations about the evaluated configuration and requests to continue or stop. A proposal describes the next configuration to evaluate. Session status and retained run labels show the current outcome."
        />
        <div className="row research-candidate-row">
          {researchRuns.length > 1 ? (
            <Field label="Research run">
              <select
                aria-label="Research run"
                value={selectedRun?.id ?? ""}
                onChange={(event) =>
                  navigate(`/runs/${event.target.value}?session=${sessionId}`)
                }
              >
                {!selectedRun && (
                  <option value="" disabled>
                    Choose a research run
                  </option>
                )}
                {researchRuns.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.label}
                  </option>
                ))}
              </select>
            </Field>
          ) : researchRuns.length === 1 ? (
            <Field
              label={selectedRun ? "Research run" : "Available research run"}
            >
              <strong>{researchRuns[0]?.label}</strong>
            </Field>
          ) : (
            <p className="subtle">No research runs recorded yet.</p>
          )}
          {retainedRun && retainedRun.id !== selectedRunId && (
            <a
              className="button secondary"
              href={`#/runs/${retainedRun.id}?session=${sessionId}`}
            >
              Open retained {retainedRun.name.toLowerCase()}
            </a>
          )}
        </div>
        {session.stopReason && (
          <p className="notice">
            <span>
              <strong>Research stopped:</strong> {session.stopReason}
            </span>
          </p>
        )}
        {session.turns.length > 0 && (
          <section className="stack">
            <h3>Researcher intent</h3>
            {session.turns.map((turn, index) => (
              <div key={index} className="research-turn">
                <h3>Turn {index + 1}</h3>
                <p>{turn.output.message}</p>
                <p className="subtle">
                  {turn.output.disposition === "keep"
                    ? "Recommends keeping"
                    : turn.output.disposition === "discard"
                      ? "Recommends discarding"
                      : turn.output.decision === "keep"
                        ? "Recommends keeping"
                        : turn.output.decision === "discard"
                          ? "Recommends discarding"
                          : "Retention unspecified"}
                  {turn.output.control === "continue"
                    ? " · Requests continuation"
                    : turn.output.control === "stop" ||
                        turn.output.decision === "stop"
                      ? " · Requests stop"
                      : " · Control unspecified"}
                  {turn.output.stopCategory === "blocked"
                    ? " · Reports a technical blocker"
                    : ""}
                </p>
                {turn.output.reason && <p>{turn.output.reason}</p>}
                <button
                  className="text-button"
                  onClick={() => setSelectedTurn({ sessionId, index })}
                >
                  Inspect full researcher turn
                </button>
              </div>
            ))}
          </section>
        )}
        <details className="disclosure">
          <summary>Recorded research activity</summary>
          <EventList
            events={events}
            empty="No researcher activity recorded yet."
          />
        </details>
      </div>
      {selectedTurn?.sessionId === sessionId && (
        <ResearchTurnDialog
          key={JSON.stringify(selectedTurn)}
          sessionId={selectedTurn.sessionId}
          index={selectedTurn.index}
          onClose={() => setSelectedTurn(null)}
        />
      )}
    </section>
  );
}

function ResearchTurnDialog({
  sessionId,
  index,
  onClose,
}: {
  sessionId: string;
  index: number;
  onClose: () => void;
}) {
  const resource = useResource("research.turn", { sessionId, index });
  return (
    <Modal title={`Recorded researcher turn ${index + 1}`} onClose={onClose}>
      <ErrorNotice error={resource.loading ? null : resource.error} />
      {resource.data ? (
        <JsonView value={resource.data} />
      ) : (
        <p className="subtle" role="status">
          {resource.loading
            ? "Loading recorded researcher turn..."
            : "The selected researcher turn could not be loaded."}
        </p>
      )}
      {resource.error && !resource.loading && (
        <button className="button secondary" onClick={resource.refresh}>
          Retry
        </button>
      )}
    </Modal>
  );
}
