import { useState } from "react";
import type { Control } from "../contracts.js";
import { command, navigate } from "./api.js";
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
  const [fullTurn, setFullTurn] = useState<unknown>(null);
  if (!resource.data) return <ErrorNotice error={resource.error} />;
  const { session, allowedActions, events } = resource.data;
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
          description="Watch the researcher propose changes and compare candidate agents. Select a run below to inspect its answers."
          details="The baseline runs first. The researcher then reviews evidence and proposes changes within your limits. Research activity and evaluation activity are recorded separately."
        />
        <div className="row research-candidate-row">
          <Field label="Candidate run">
            <select
              aria-label="Research candidate run"
              value={selectedRunId}
              onChange={(event) =>
                navigate(`/runs/${event.target.value}?session=${sessionId}`)
              }
            >
              {session.runIds.map((id, index) => (
                <option key={id} value={id}>
                  {index === 0 ? "Baseline" : `Candidate ${index}`}
                  {id === session.bestRunId ? " · retained" : ""}
                  {id === session.currentRunId ? " · current" : ""}
                </option>
              ))}
            </select>
          </Field>
          <a
            className="button secondary"
            href={`#/runs/${session.bestRunId}?session=${sessionId}`}
          >
            Open retained{" "}
            {session.bestRunId === session.baselineRunId
              ? "baseline"
              : "candidate"}
          </a>
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
            <h3>Decisions</h3>
            {session.turns.map((turn, index) => (
              <div key={index} className="research-turn">
                <h3>Turn {index + 1}</h3>
                <p>{turn.output.message}</p>
                <p className="subtle">
                  {turn.output.disposition === "keep"
                    ? "Candidate kept"
                    : turn.output.disposition === "discard"
                      ? "Candidate discarded"
                      : turn.output.decision === "keep"
                        ? "Candidate kept"
                        : turn.output.decision === "discard"
                          ? "Candidate discarded"
                          : "Evidence reviewed"}
                  {turn.output.control === "stop" ||
                  turn.output.decision === "stop"
                    ? " · Research stopped"
                    : " · Research continued"}
                  {turn.output.stopCategory === "blocked"
                    ? " because technical problems prevent a useful comparison"
                    : ""}
                </p>
                {turn.output.reason && <p>{turn.output.reason}</p>}
                <button
                  className="text-button"
                  onClick={() => {
                    void command("research.turn", { sessionId, index })
                      .then(setFullTurn)
                      .catch(setError);
                  }}
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
      {fullTurn !== null && (
        <Modal
          title="Recorded researcher turn"
          onClose={() => setFullTurn(null)}
        >
          <JsonView value={fullTurn} />
        </Modal>
      )}
    </section>
  );
}
