import { useRef, useState } from "react";
import type { RunView } from "../contracts.js";
import { command, navigate } from "./api.js";
import { ErrorNotice, Modal } from "./ui.js";

export const failureLabels: Record<string, string> = {
  "provider-capacity": "Provider at capacity",
  "rate-limit": "Provider rate limit",
  authentication: "Authentication failed",
  configuration: "Configuration needs correction",
  "missing-answer": "No answer submitted",
  submission: "Answer submission rejected",
  tool: "Tool failure",
  harness: "Agent harness failure",
  timeout: "Attempt timed out",
  unknown: "Cause not established",
};

export function RetryFailures({ view }: { view: RunView }) {
  const [open, setOpen] = useState(false);
  const [acknowledge, setAcknowledge] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const key = useRef<string | undefined>(undefined);
  const failed = view.retryEligibility?.resultIds ?? [];
  if (!failed.length) return null;
  const settled = view.retryEligibility?.available ?? false;
  const uncertain = view.retryEligibility?.requiresAcknowledgment ?? true;
  return (
    <>
      <button
        className="button secondary"
        disabled={!settled}
        title={
          settled
            ? "Retry execution failures without repeating graded answers"
            : (view.retryEligibility?.reason ?? "Retry is not available")
        }
        onClick={() => setOpen(true)}
      >
        Rerun failed questions ({failed.length})
      </button>
      {open && (
        <Modal
          title="Rerun failed questions"
          onClose={() => {
            if (!pending) setOpen(false);
          }}
        >
          <div className="stack">
            <p>
              Retry {failed.length} unanswered questions using the same frozen
              questions, agent settings, and evaluation rules. Incorrect answers
              are excluded.
            </p>
            <p className="subtle">
              This creates a linked run. Apply its completed answers to update
              this run's results and scores. Original attempts, scores, and
              research decisions stay available. New attempts can incur
              additional usage.
            </p>
            {uncertain && (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={acknowledge}
                  onChange={(event) => setAcknowledge(event.target.checked)}
                />
                <span>
                  Previous attempts might have performed tool actions or remote
                  work. Retrying can repeat those actions.
                </span>
              </label>
            )}
            <ErrorNotice error={error} />
            <button
              className="button primary"
              disabled={pending || (uncertain && !acknowledge)}
              onClick={() => {
                key.current ??= crypto.randomUUID();
                setPending(true);
                setError(undefined);
                void command("runs.retry-failed", {
                  runId: view.run.id,
                  idempotencyKey: key.current,
                  acknowledgeDuplicateWork: acknowledge,
                })
                  .then((result) => navigate(`/runs/${result.run.id}`))
                  .catch(setError)
                  .finally(() => setPending(false));
              }}
            >
              {pending ? "Starting retry..." : "Start retry run"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
