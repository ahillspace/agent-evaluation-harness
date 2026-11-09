import { useState } from "react";
import type { AssessmentPassObservation, RunView } from "../contracts.js";
import { CommandError, command, useResource } from "./api.js";
import { Answer } from "./answer.js";
import { AssessmentScore } from "./assessment-controls.js";
import { ErrorNotice, Field, Modal, Status } from "./ui.js";
import { questionEvidence } from "./question-evidence.js";

type ReviewChange = {
  choice: "note" | "correct" | "incorrect" | "excluded";
  note: string;
};

export function ReviewDialog({
  view,
  pass,
  resultId,
  onClose,
  onSaved,
}: {
  view: RunView;
  pass: AssessmentPassObservation;
  resultId?: string;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [selected, setSelected] = useState(
    resultId ?? view.results[0]?.id ?? "",
  );
  const [changes, setChanges] = useState<Record<string, ReviewChange>>({});
  const [name, setName] = useState(`Human review of ${pass.name}`);
  const [reviewer, setReviewer] = useState("Local reviewer");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const detail = useResource("runs.assessment", {
    runId: view.run.id,
    passId: pass.id,
    expectedObservationRevision: pass.observationRevision,
  });
  const configuration =
    detail.data?.observationRevision === pass.observationRevision
      ? detail.data.configuration
      : undefined;
  const change = changes[selected] ?? { choice: "note", note: "" };
  const judgment = pass.judgments.find((item) => item.resultId === selected);
  const result = view.results.find((item) => item.id === selected);
  const source = result ? questionEvidence(view, result, pass) : undefined;
  const evidence = useResource(
    "runs.attempt",
    { runId: view.run.id, attemptId: source?.attempt?.id ?? "" },
    undefined,
    !!source?.completed,
  );
  const question = (
    configuration?.referenceBank ??
    (pass.basis.bankRevisionId === view.run.manifest.bank.id
      ? view.run.manifest.bank
      : undefined)
  )?.questions.find((item) => item.id === result?.questionId);
  const edited = Object.entries(changes).filter(
    ([, item]) => item.choice !== "note" || item.note.trim(),
  );
  const update = (patch: Partial<ReviewChange>) =>
    setChanges({ ...changes, [selected]: { ...change, ...patch } });
  const save = async () => {
    setPending(true);
    setError(null);
    try {
      const saved = await command("runs.review-assessment", {
        runId: view.run.id,
        parentPassId: pass.id,
        expectedObservationRevision: pass.observationRevision,
        name,
        reviewer,
        overrides: edited.map(([id, item]) => ({
          resultId: id,
          verdict:
            item.choice === "correct"
              ? true
              : item.choice === "incorrect"
                ? false
                : null,
          note: item.note,
          exclude: item.choice === "excluded",
        })),
      });
      onSaved(saved.id);
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  };
  const issue = error ?? detail.error ?? evidence.error;
  const conflict = issue instanceof CommandError && issue.code === "conflict";
  return (
    <Modal
      title="Review judgments"
      onClose={() => {
        if (!pending) onClose();
      }}
    >
      <p className="subtle">
        Start from {pass.name}. Change judgments or add notes. Untouched
        judgments carry forward into your named score.
      </p>
      <ErrorNotice
        error={
          conflict
            ? "The score changed. Close this review and reopen it from the current score. Your unsaved edits remain until you close this review."
            : issue
        }
      />
      {detail.error && issue === detail.error && !conflict && (
        <div className="actions">
          <button className="button secondary" onClick={detail.refresh}>
            Retry loading
          </button>
        </div>
      )}
      <fieldset className="judge-fieldset stack" disabled={pending}>
        <div className="review-basis">
          <span>Before review</span>
          <AssessmentScore pass={pass} />
        </div>
        <Field label="Review name">
          <input
            aria-label="Review name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Question">
          <select
            aria-label="Review question"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            {view.results.map((item) => (
              <option key={item.id} value={item.id}>
                {item.questionId} · repetition {item.repetition}
                {changes[item.id] ? " · edited" : ""}
              </option>
            ))}
          </select>
        </Field>
        <p>
          {
            view.run.manifest.questions.find(
              (item) => item.id === result?.questionId,
            )?.text
          }
        </p>
        <details className="disclosure">
          <summary>Recorded answer and reference</summary>
          <h3>Recorded answer</h3>
          {source?.fromRerun && (
            <p className="subtle">
              Applied rerun answer. Original failed attempts remain saved.
            </p>
          )}
          {evidence.data?.attempt.output ? (
            <Answer value={evidence.data.attempt.output.answer} />
          ) : (
            <p className="subtle">
              {source?.completed
                ? "Loading saved answer..."
                : "No answer recorded."}
            </p>
          )}
          <h3>Expected answer</h3>
          {question ? (
            <Answer value={question.expected} />
          ) : (
            <p className="subtle">Loading this assessment's reference...</p>
          )}
        </details>
        <div className="actions">
          <Status value={judgment?.status ?? "unjudged"} />
          <span className="subtle">
            {judgment?.explanation ?? "No judgment recorded."}
          </span>
        </div>
        {!source?.completed && (
          <p className="notice">
            This question has no completed answer. Review notes stay saved
            alongside its execution status.
          </p>
        )}
        <Field label="Review decision">
          <select
            aria-label="Review decision"
            value={change.choice}
            onChange={(event) =>
              update({ choice: event.target.value as ReviewChange["choice"] })
            }
          >
            <option value="note">Keep judgment and add a note</option>
            <option value="correct" disabled={!source?.completed}>
              Pass
            </option>
            <option value="incorrect" disabled={!source?.completed}>
              Fail
            </option>
            <option value="excluded">Exclude from this score</option>
          </select>
        </Field>
        <Field label="Reason or review note">
          <textarea
            aria-label="Reason or review note"
            rows={4}
            value={change.note}
            onChange={(event) => update({ note: event.target.value })}
          />
        </Field>
        <Field label="Reviewer">
          <input
            aria-label="Reviewer"
            value={reviewer}
            onChange={(event) => setReviewer(event.target.value)}
          />
        </Field>
        <p className="subtle">
          {edited.length} questions reviewed. Each change records the prior
          judgment, reviewer, and reason. Excluded questions are reported
          separately.
        </p>
        <button
          className="button primary"
          disabled={
            conflict ||
            !edited.length ||
            !configuration ||
            !name.trim() ||
            !reviewer.trim() ||
            edited.some(([, item]) => !item.note.trim())
          }
          onClick={() => {
            void save();
          }}
        >
          {pending ? "Saving review..." : "Save reviewed score"}
        </button>
      </fieldset>
    </Modal>
  );
}
