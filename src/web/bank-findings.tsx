import { useState } from "react";
import type { BankFinding, BankRevision } from "../contracts.js";
import { command, useResource } from "./api.js";
import { ErrorNotice, Field, date, json } from "./ui.js";

export function BankFindings({
  bankId,
  revision,
  onSaved,
}: {
  bankId: string;
  revision?: BankRevision;
  onSaved: () => void;
}) {
  const findings = useResource("banks.findings", { bankId });
  const [showResolved, setShowResolved] = useState(false);
  const visible = (findings.data ?? []).filter(
    (finding) => showResolved || finding.status === "open",
  );
  return (
    <div className="panel-body stack">
      <div className="row">
        <div>
          <h3>Question findings</h3>
          <p className="subtle">
            Review suspected reference, wording, duplicate, and datasource
            issues. Corrections publish a new revision; previous evidence stays
            available.
          </p>
        </div>
        <button className="button secondary" onClick={findings.refresh}>
          Refresh findings
        </button>
      </div>
      <ErrorNotice error={findings.error} />
      <label className="check-row">
        <input
          type="checkbox"
          checked={showResolved}
          onChange={(event) => setShowResolved(event.target.checked)}
        />
        <span>Include resolved findings</span>
      </label>
      {visible.map((finding) => (
        <Finding
          key={finding.id}
          finding={finding}
          revision={revision}
          onSaved={() => {
            findings.refresh();
            onSaved();
          }}
        />
      ))}
      {!visible.length && (
        <p className="subtle">
          {findings.data
            ? "No open findings. Report a suspected issue from a saved run's question details."
            : "Loading findings..."}
        </p>
      )}
    </div>
  );
}
function Finding({
  finding,
  revision,
  onSaved,
}: {
  finding: BankFinding;
  revision?: BankRevision;
  onSaved: () => void;
}) {
  const [action, setAction] = useState("record");
  const [note, setNote] = useState("");
  const [reviewer, setReviewer] = useState("Local reviewer");
  const question = revision?.questions.find(
    (item) => item.id === finding.questionId,
  );
  const [expected, setExpected] = useState(json(question?.expected ?? null));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const sourceQuery = new URLSearchParams();
  if (finding.resultId) sourceQuery.set("result", finding.resultId);
  if (finding.passId) sourceQuery.set("score", finding.passId);
  const resolve = async (status: "accepted" | "dismissed") => {
    setPending(true);
    setError(null);
    try {
      await command("banks.resolve-finding", {
        findingId: finding.id,
        status,
        note,
        reviewer,
        exclude: status === "accepted" && action === "exclude",
        ...(status === "accepted" && action === "correct"
          ? { expected: JSON.parse(expected) }
          : {}),
      });
      onSaved();
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  };
  return (
    <article className="panel panel-body stack">
      <div className="row">
        <div>
          <span className="tag">{finding.kind}</span>{" "}
          <span className="tag">{finding.status}</span>
          <h4>{finding.title}</h4>
          <p className="subtle">
            {finding.questionId} · {date(finding.createdAt)}
          </p>
        </div>
        {finding.runId && (
          <a
            className="button secondary"
            href={`#/observe/${finding.runId}${sourceQuery.size ? `?${sourceQuery.toString()}` : ""}`}
          >
            Open source evidence
          </a>
        )}
      </div>
      <p>{finding.note}</p>
      {finding.resolution ? (
        <p className="subtle">
          Resolved by {finding.resolution.reviewer}:{" "}
          {finding.resolution.note || finding.status}
          {finding.resolution.bankRevisionId
            ? " A new question revision was published."
            : ""}
        </p>
      ) : (
        <>
          <ErrorNotice error={error} />
          <Field label="Resolution">
            <select
              aria-label={`Resolution for ${finding.questionId}`}
              value={action}
              onChange={(event) => setAction(event.target.value)}
            >
              <option value="record">
                Accept finding without changing references
              </option>
              <option value="correct">Publish corrected expected answer</option>
              <option value="exclude">
                Exclude from future accuracy until reviewed
              </option>
            </select>
          </Field>
          {action === "correct" && (
            <Field label="Corrected expected answer (JSON)">
              <textarea
                aria-label={`Corrected expected answer for ${finding.questionId}`}
                rows={8}
                value={expected}
                onChange={(event) => setExpected(event.target.value)}
              />
            </Field>
          )}
          {action === "exclude" && (
            <p className="notice">
              Publishes an evaluator revision that marks this question as
              needing review. Existing scores keep their original question
              counts.
            </p>
          )}
          <Field label="Resolution note">
            <textarea
              aria-label={`Resolution note for ${finding.questionId}`}
              rows={3}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
          <Field label="Reviewer">
            <input
              aria-label={`Reviewer for ${finding.questionId}`}
              value={reviewer}
              onChange={(event) => setReviewer(event.target.value)}
            />
          </Field>
          <div className="actions">
            <button
              className="button primary"
              disabled={pending || !reviewer.trim()}
              onClick={() => void resolve("accepted")}
            >
              {pending
                ? "Saving..."
                : action === "correct"
                  ? "Publish correction"
                  : action === "exclude"
                    ? "Publish exclusion"
                    : "Accept finding"}
            </button>
            <button
              className="button secondary"
              disabled={pending || !reviewer.trim()}
              onClick={() => void resolve("dismissed")}
            >
              Dismiss finding
            </button>
          </div>
        </>
      )}
    </article>
  );
}
