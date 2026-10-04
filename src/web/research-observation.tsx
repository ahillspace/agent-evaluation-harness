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
          <div className="eyebrow">Persistent research session</div>
          <h2>{session.name}</h2>
          <p>
            {session.runIds.length} runs · {session.turns.length} researcher
            turns · <Status value={session.status} />
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
        <div className="row">
          <Field label="Candidate run">
            <select
              aria-label="Research candidate run"
              value={selectedRunId}
              onChange={(event) =>
                navigate(`/observe/${event.target.value}?session=${sessionId}`)
              }
            >
              {session.runIds.map((id, index) => (
                <option key={id} value={id}>
                  {index === 0 ? "Baseline" : `Candidate ${index}`}
                  {id === session.bestRunId ? " · best" : ""}
                  {id === session.currentRunId ? " · current" : ""}
                </option>
              ))}
            </select>
          </Field>
          <span className="subtle">
            {session.stopReason ??
              "Every candidate is an ordinary, inspectable run."}
          </span>
        </div>
        <details className="disclosure">
          <summary>Researcher activity and decisions</summary>
          <EventList
            events={events}
            empty="No researcher events recorded yet."
          />
          {session.turns.map((turn, index) => (
            <div key={index} className="research-turn">
              <h3>Turn {index + 1}</h3>
              <p>{turn.output.message}</p>
              <p className="subtle">
                {turn.output.decision} {turn.output.reason}
              </p>
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
