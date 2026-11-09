import { useState } from "react";
import type { RunView } from "../contracts.js";
import type { RunRecovery } from "./run-recovery.js";
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

export function RetryFailures({
  view,
  recovery,
}: {
  view: RunView;
  recovery: RunRecovery;
}) {
  const [open, setOpen] = useState(false);
  const [acknowledge, setAcknowledge] = useState(false);
  const failed = view.retryEligibility?.resultIds ?? [];
  if (!failed.length || recovery.request) return null;
  const available =
    view.retryEligibility?.available && recovery.ready && !recovery.busy;
  const uncertain = view.retryEligibility?.requiresAcknowledgment ?? true;
  return (
    <>
      <button
        className="button secondary"
        disabled={!available}
        title={
          view.retryEligibility?.available
            ? "Recover unanswered failures in this Run"
            : view.retryEligibility?.reason
        }
        onClick={() => {
          setAcknowledge(false);
          setOpen(true);
        }}
      >
        Rerun failed questions ({failed.length})
      </button>
      {open && (
        <Modal
          title="Rerun failed questions"
          onClose={() => {
            if (!recovery.busy) setOpen(false);
          }}
        >
          <div className="stack">
            <p>
              Recover {failed.length} unanswered question
              {failed.length === 1 ? "" : "s"} here with the same frozen
              settings. Incorrect answers stay unchanged.
            </p>
            <p className="subtle">
              Earlier attempts and scores stay available. New attempts can incur
              additional usage.
              {view.run.researchSessionId && (
                <>
                  {" "}
                  New attempts use this Run's limits and do not count toward the
                  finished research budget.
                </>
              )}
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
            <ErrorNotice error={recovery.error} />
            <button
              className="button primary"
              disabled={!available || (uncertain && !acknowledge)}
              onClick={() => {
                setOpen(false);
                void recovery.submit({
                  operation: "runs.retry-failed",
                  input: {
                    runId: view.run.id,
                    expectedExecutionId: view.run.execution?.id ?? view.run.id,
                    idempotencyKey: crypto.randomUUID(),
                    acknowledgeDuplicateWork: acknowledge,
                  },
                });
              }}
            >
              Rerun failed questions
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
