import { useState } from "react";
import type {
  JevAssessmentRecord,
  JevAssessmentSummary,
  CommandInput,
} from "../contracts.js";
import { CommandError, useResource } from "./api.js";
import { ErrorNotice, JsonView, Modal, date } from "./ui.js";

const labels = {
  answer: "Answer correctness",
  evidence: "Evidence support",
  reference: "Reference consistency",
} as const;
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
export function jevErrorLabel(code?: string) {
  return code === "token_limit_exceeded"
    ? "Not judged: token limit exceeded"
    : code === "capacity_exceeded"
      ? "Not judged: request limit exceeded"
      : "Not judged: provider error";
}
export function JevAssessment({
  assessment,
  inspect = false,
  assessmentContext,
}: {
  assessment: JevAssessmentSummary | JevAssessmentRecord;
  inspect?: boolean;
  assessmentContext?: CommandInput<"jev.get">["assessmentContext"];
}) {
  const input = { assessmentId: assessment.id, assessmentContext };
  const inspectionKey = JSON.stringify(input);
  const [openedKey, setOpenedKey] = useState<string | null>(null);
  const open = inspect && openedKey === inspectionKey;
  const fullRecord = "configuration" in assessment ? assessment : null;
  const resource = useResource(
    "jev.get",
    input,
    undefined,
    open && !fullRecord && !!assessmentContext,
  );
  const detail = fullRecord ?? resource.data;
  const conflict =
    resource.error instanceof CommandError &&
    resource.error.code === "conflict";
  const fallbackApplied =
    "configuration" in assessment
      ? Boolean(assessment.fallback)
      : Boolean(assessment.fallbackApplied);
  return (
    <article className="jev-assessment stack">
      <div className="assessment-row">
        <strong>Jev</strong>
        <span>
          {assessment.status === "error"
            ? jevErrorLabel(assessment.error?.code)
            : assessment.status === "pending"
              ? "Pending"
              : assessment.reviewRequired
                ? "Needs review"
                : "Recorded"}
        </span>
      </div>
      <p className="subtle">
        {assessment.published ? "Saved assessment" : "Preview"}
        {assessment.model ? ` · ${assessment.model}` : ""}
      </p>
      <p className="subtle">
        {assessment.kind === "original"
          ? "Run-time assessment"
          : "Saved-answer assessment"}{" "}
        · {date(assessment.createdAt)}
      </p>
      <p className="subtle">
        {"configuration" in assessment
          ? `${assessment.configuration.profile.name} · revision ${assessment.configuration.profile.number}`
          : `${assessment.profileName} · revision ${assessment.profileRevisionNumber}`}
      </p>
      {fallbackApplied && (
        <div className="notice">
          <strong>Answer-only fallback</strong>
          <p>
            The trace request exceeded Jev's limit. The fallback judges the
            complete answer and expected answer without agent activity.
          </p>
        </div>
      )}
      {assessment.error && (
        <div role="alert" className="notice error">
          <strong>{assessment.error.code}</strong>
          <p>{assessment.error.message}</p>
        </div>
      )}
      {assessment.checks &&
        (Object.keys(labels) as Array<keyof typeof labels>).map((key) => {
          const result = assessment.checks![key];
          if (!result)
            return (
              <section className="jev-check" key={key}>
                <h4>{labels[key]}</h4>
                <p className="subtle">Not assessed</p>
              </section>
            );
          return (
            <section className="jev-check" key={key}>
              <h4>{labels[key]}</h4>
              <div className="assessment-row">
                <strong>{result.choice.replaceAll("_", " ")}</strong>
                <span>{percent(result.confidence)} confidence</span>
              </div>
              <dl className="jev-probabilities">
                {Object.entries(result.probabilities).map(
                  ([label, probability]) => (
                    <div key={label}>
                      <dt>{label.replaceAll("_", " ")}</dt>
                      <dd>{percent(probability)}</dd>
                    </div>
                  ),
                )}
              </dl>
            </section>
          );
        })}
      {inspect && (
        <button
          className="text-button"
          disabled={!fullRecord && !assessmentContext}
          onClick={() => setOpenedKey(inspectionKey)}
        >
          Inspect recorded request and provenance
        </button>
      )}
      {open && (
        <Modal
          title="Jev assessment provenance"
          onClose={() => setOpenedKey(null)}
        >
          {assessment.status === "pending" && (
            <p className="subtle">
              Pending provenance is live until this assessment settles.
            </p>
          )}
          <ErrorNotice error={resource.error} />
          {!detail && (
            <p className="subtle">
              {resource.error
                ? "The selected assessment's provenance could not be loaded."
                : "Loading recorded provenance..."}
            </p>
          )}
          {resource.error && !conflict && (
            <button className="button secondary" onClick={resource.refresh}>
              Retry loading
            </button>
          )}
          {detail && (
            <>
              <p>
                Profile {detail.configuration.profile.name} · revision{" "}
                {detail.configuration.profile.number}
              </p>
              <p className="subtle">
                Evidence hash: <code>{detail.evidenceHash}</code>
              </p>
              <details className="disclosure">
                <summary>Exact judge request and response</summary>
                <JsonView
                  value={{
                    assessmentId: detail.id,
                    runId: detail.runId,
                    resultId: detail.resultId,
                    attemptId: detail.attemptId,
                    kind: detail.kind,
                    status: detail.status,
                    published: detail.published,
                    createdAt: detail.createdAt,
                    finishedAt: detail.finishedAt,
                    checks: detail.checks,
                    reviewRequired: detail.reviewRequired,
                    request: detail.request,
                    response: detail.response,
                    attempts: detail.attempts,
                    requestId: detail.requestId,
                    model: detail.model,
                    error: detail.error,
                    httpStatus: detail.httpStatus,
                    usage: detail.usage,
                    pricing: detail.pricing,
                  }}
                />
              </details>
              <details className="disclosure">
                <summary>Full recorded evidence and criteria</summary>
                <JsonView
                  value={{
                    evidence: detail.evidence,
                    criteria: detail.criteria,
                    configuration: detail.configuration,
                    configurationHash: detail.configurationHash,
                    attemptEvidenceHash: detail.attemptEvidenceHash,
                    bankRevisionId: detail.bankRevisionId,
                    evaluatorRevisionId: detail.evaluatorRevisionId,
                  }}
                />
              </details>
              {detail.fallback && (
                <details className="disclosure">
                  <summary>Original size error and fallback criteria</summary>
                  <JsonView value={detail.fallback} />
                </details>
              )}
            </>
          )}
        </Modal>
      )}
    </article>
  );
}
