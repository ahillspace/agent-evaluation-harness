import { useState } from "react";
import type { AssessmentPassObservation } from "../contracts.js";
import { useResource } from "./api.js";
import { ErrorNotice, JsonView } from "./ui.js";

type Judgment = AssessmentPassObservation["judgments"][number];

export function AssessmentExchange({
  runId,
  pass,
  judgment,
}: {
  runId: string;
  pass: AssessmentPassObservation;
  judgment: Judgment;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="disclosure inspector-section"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Assessment request and response</summary>
      {open && (
        <RecordedExchange runId={runId} pass={pass} judgment={judgment} />
      )}
    </details>
  );
}

function RecordedExchange({
  runId,
  pass,
  judgment,
}: {
  runId: string;
  pass: AssessmentPassObservation;
  judgment: Judgment;
}) {
  const resource = useResource("runs.export-assessment", {
    runId,
    passId: pass.id,
    expectedObservationRevision: pass.observationRevision,
  });
  const recorded = resource.data?.judgments.find(
    (item) => item.resultId === judgment.resultId,
  );
  const mismatch =
    resource.data &&
    (resource.data.id !== pass.id ||
      resource.data.runId !== runId ||
      !recorded ||
      recorded.attemptId !== judgment.attemptId ||
      recorded.evidenceHash !== judgment.evidenceHash ||
      recorded.source?.runId !== judgment.source?.runId ||
      recorded.source?.resultId !== judgment.source?.resultId ||
      recorded.judgmentId !== judgment.judgmentId ||
      !("request" in recorded || "response" in recorded));
  const error =
    resource.error ??
    (mismatch
      ? new Error(
          "The recorded exchange does not match the selected score's answer. Refresh the score before inspecting it.",
        )
      : null);
  if (error)
    return (
      <>
        <ErrorNotice error={error} />
        <button className="button secondary" onClick={resource.refresh}>
          Retry loading assessment exchange
        </button>
      </>
    );
  if (!recorded)
    return (
      <p className="waiting-text">Loading recorded assessment exchange...</p>
    );
  return (
    <JsonView
      value={{
        request: recorded.request,
        response: recorded.response,
        configuration: resource.data?.configuration.judge,
      }}
    />
  );
}
