import { useEffect, useRef, useState } from "react";
import type { RunView } from "../contracts.js";
import { command, navigate } from "./api.js";
import { ErrorNotice, Modal } from "./ui.js";

type Candidate = NonNullable<RunView["retryRuns"]>[number];

export function RetryResults({
  view,
  onSaved,
}: {
  view: RunView;
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [pending, setPending] = useState(false);
  const [replace, setReplace] = useState(false);
  const [error, setError] = useState<unknown>();
  const key = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const eligibility = view.retryApplyEligibility;
  const child = eligibility && view.run.retryOf;
  const candidates: Candidate[] = child
    ? [{ ...eligibility, runId: view.run.id, name: "This rerun" }]
    : (view.retryRuns ?? []);
  const applications = view.retryApplications ?? [];
  const open = (candidate: Candidate) => {
    setSelected(candidate);
    setError(undefined);
    setReplace(false);
    key.current = undefined;
  };
  const pendingIds =
    selected?.resultIds.filter(
      (id) => !selected.alreadyAppliedResultIds.includes(id),
    ) ?? [];
  const replacing =
    selected?.replacementResultIds?.some((id) => pendingIds.includes(id)) ??
    false;
  if (!view.run.retryOf && !candidates.length && !applications.length)
    return null;
  return (
    <section className="retry-results" aria-label="Rerun recovery">
      {view.run.retryOf && (
        <p>
          This rerun is linked to{" "}
          <a href={`#/observe/${view.run.retryOf.runId}`}>the original run</a>.
          {eligibility?.alreadyAppliedResultIds.length
            ? ` ${eligibility.alreadyAppliedResultIds.length} answer${eligibility.alreadyAppliedResultIds.length === 1 ? " is" : "s are"} already applied.`
            : " Apply completed answers to update its results and saved scores."}
        </p>
      )}
      {!view.run.retryOf && applications.length > 0 && (
        <details>
          <summary>Applied rerun history ({applications.length})</summary>
          <ul>
            {applications.map((item) => (
              <li key={item.id}>
                {item.bindings.length} answer
                {item.bindings.length === 1 ? "" : "s"} from{" "}
                <a href={`#/observe/${item.retryRunId}`}>rerun</a>. Original
                attempts and scores stay available.
              </li>
            ))}
          </ul>
        </details>
      )}
      {candidates.map((candidate) => (
        <div className="retry-result-row" key={candidate.runId}>
          <div>
            {!child && <strong>{candidate.name}</strong>}
            {candidate.reason && <p className="subtle">{candidate.reason}</p>}
          </div>
          <button
            className="button secondary"
            disabled={!candidate.available}
            title={candidate.reason}
            onClick={() => open(candidate)}
          >
            Apply rerun results
          </button>
        </div>
      ))}
      {selected && (
        <Modal
          title="Apply rerun results"
          onClose={() => {
            if (!pending) setSelected(null);
          }}
        >
          <div className="stack">
            <p>
              Use {pendingIds.length} completed rerun answer
              {pendingIds.length === 1 ? "" : "s"} in the original run. Matching
              saved scores update together, including available judge results.
            </p>
            <p>
              Original attempts and scores stay available. This does not run the
              agent or judges again.
            </p>
            {replacing && (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={replace}
                  onChange={(event) => setReplace(event.target.checked)}
                />
                <span>
                  Replace previously applied rerun answers with this rerun.
                  Earlier answers and scores stay available.
                </span>
              </label>
            )}
            <ErrorNotice error={error} />
            <button
              className="button primary"
              disabled={
                pending || (replacing && !replace) || !pendingIds.length
              }
              onClick={() => {
                key.current ??= crypto.randomUUID();
                setPending(true);
                setError(undefined);
                void command("runs.apply-retry", {
                  runId: view.run.retryOf?.runId ?? view.run.id,
                  retryRunId: selected.runId,
                  resultIds: pendingIds,
                  replaceApplied: replacing && replace,
                  idempotencyKey: key.current,
                })
                  .then(() => {
                    if (!mounted.current) return;
                    setSelected(null);
                    onSaved();
                    if (view.run.retryOf)
                      navigate(`/observe/${view.run.retryOf.runId}`);
                  })
                  .catch((cause: unknown) => {
                    if (mounted.current) setError(cause);
                  })
                  .finally(() => {
                    if (mounted.current) setPending(false);
                  });
              }}
            >
              {pending
                ? "Applying answers..."
                : `Apply ${pendingIds.length} answer${pendingIds.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
