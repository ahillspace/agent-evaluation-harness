import { useState } from "react";
import type { AttemptSummary } from "../contracts.js";
import { useResource } from "./api.js";
import { Answer } from "./answer.js";
import { ErrorNotice, JsonView } from "./ui.js";

export function SavedAnswer({
  runId,
  attempt,
}: {
  runId: string;
  attempt: AttemptSummary;
}) {
  const resource = useResource(
    "runs.answer",
    {
      runId,
      attemptId: attempt.id,
      expectedEvidenceHash: attempt.evidenceHash ?? "",
    },
    undefined,
    !!attempt.evidenceHash,
  );
  if (!attempt.evidenceHash)
    return (
      <p className="waiting-text">
        The saved answer has no sealed evidence identity.
      </p>
    );
  const error =
    resource.error ??
    (resource.data &&
    (resource.data.attemptId !== attempt.id ||
      resource.data.evidenceHash !== attempt.evidenceHash)
      ? new Error(
          "The saved answer does not match the selected sealed evidence.",
        )
      : null);
  if (error)
    return (
      <>
        <ErrorNotice error={error} />
        <button className="button secondary" onClick={resource.refresh}>
          Retry loading answer
        </button>
      </>
    );
  return resource.data ? (
    <Answer value={resource.data.answer} />
  ) : (
    <p className="waiting-text">Loading saved answer...</p>
  );
}

export function OriginalResponse({
  runId,
  attempt,
}: {
  runId: string;
  attempt: AttemptSummary;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="disclosure"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Original response text</summary>
      {open && <OriginalResponseText runId={runId} attempt={attempt} />}
    </details>
  );
}

function OriginalResponseText({
  runId,
  attempt,
}: {
  runId: string;
  attempt: AttemptSummary;
}) {
  const resource = useResource("runs.attempt", {
    runId,
    attemptId: attempt.id,
    expectedEvidenceHash: attempt.evidenceHash,
  });
  if (resource.error)
    return (
      <>
        <ErrorNotice error={resource.error} />
        <button className="button secondary" onClick={resource.refresh}>
          Retry loading original response
        </button>
      </>
    );
  return resource.data ? (
    <pre>{resource.data.attempt.output?.text}</pre>
  ) : (
    <p className="waiting-text">Loading original response...</p>
  );
}

export function RecordedAttemptData({
  runId,
  attempt,
}: {
  runId: string;
  attempt?: AttemptSummary;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="disclosure"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Recorded attempt data</summary>
      {open &&
        (attempt ? (
          <AttemptData runId={runId} attempt={attempt} />
        ) : (
          <JsonView value={{ status: "No attempt recorded" }} />
        ))}
    </details>
  );
}

function AttemptData({
  runId,
  attempt,
}: {
  runId: string;
  attempt: AttemptSummary;
}) {
  const resource = useResource(
    "runs.attempt",
    {
      runId,
      attemptId: attempt.id,
      expectedEvidenceHash: attempt.evidenceHash,
    },
    undefined,
    attempt.status !== "running" &&
      (!attempt.hasOutput || !!attempt.evidenceHash),
  );
  if (resource.error)
    return (
      <>
        <ErrorNotice error={resource.error} />
        <button className="button secondary" onClick={resource.refresh}>
          Retry loading attempt data
        </button>
      </>
    );
  return (
    <>
      {resource.loading && (
        <p className="waiting-text">Loading recorded attempt...</p>
      )}
      <JsonView
        value={{ metadata: attempt, recordedEvidence: resource.data?.attempt }}
      />
    </>
  );
}

export function FailedAnswer({
  runId,
  attempt,
}: {
  runId: string;
  attempt: AttemptSummary;
}) {
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const resource = useResource(
    "runs.attempt",
    {
      runId,
      attemptId: attempt.id,
      expectedEvidenceHash: attempt.evidenceHash,
    },
    undefined,
    !attempt.hasOutput || !!attempt.evidenceHash,
  );
  const transport = resource.data?.attempt.failure?.transport;
  const text =
    transport &&
    typeof transport === "object" &&
    !Array.isArray(transport) &&
    typeof transport.text === "string"
      ? transport.text
      : undefined;
  return (
    <>
      <ErrorNotice error={resource.error} />
      {resource.error && (
        <button className="button secondary" onClick={resource.refresh}>
          Retry loading attempt data
        </button>
      )}
      <p className="waiting-text">No final answer recorded for this attempt.</p>
      {text && (
        <section className="stack">
          <p className="notice">
            Final response saved, but no answer was submitted successfully. This
            remains an execution failure.
          </p>
          <pre className="code-block">{text}</pre>
          <details
            className="disclosure"
            onToggle={(event) => setDiagnosticsOpen(event.currentTarget.open)}
          >
            <summary>Submission failure evidence</summary>
            {diagnosticsOpen && <JsonView value={transport} />}
          </details>
        </section>
      )}
    </>
  );
}
