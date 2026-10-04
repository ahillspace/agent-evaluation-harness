import { useState } from "react";
import { command } from "./api.js";
import { ErrorNotice, Field, Modal } from "./ui.js";

export function ReviewDialog({
  runId,
  resultId,
  scoreSetId,
  onClose,
  onSaved,
}: {
  runId: string;
  resultId: string;
  scoreSetId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [verdict, setVerdict] = useState(true),
    [note, setNote] = useState(""),
    [reviewer, setReviewer] = useState("Local reviewer"),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(null);
  return (
    <Modal title="Add human review" onClose={onClose}>
      <ErrorNotice error={error} />
      <p className="subtle">
        Your review is an independent assessment. It does not replace
        deterministic grading.
      </p>
      <div className="stack">
        <Field label="Verdict">
          <select
            aria-label="Human review verdict"
            value={String(verdict)}
            onChange={(event) => setVerdict(event.target.value === "true")}
          >
            <option value="true">Pass</option>
            <option value="false">Fail</option>
          </select>
        </Field>
        <Field label="Reviewer">
          <input
            aria-label="Reviewer"
            value={reviewer}
            onChange={(event) => setReviewer(event.target.value)}
          />
        </Field>
        <Field label="Review note">
          <textarea
            aria-label="Review note"
            rows={5}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
        <button
          className="button primary"
          disabled={pending}
          onClick={() => {
            setPending(true);
            void command("runs.review", {
              runId,
              resultId,
              scoreSetId,
              verdict,
              note,
              reviewer,
            })
              .then(onSaved)
              .catch(setError)
              .finally(() => setPending(false));
          }}
        >
          {pending ? "Saving..." : "Save review"}
        </button>
      </div>
    </Modal>
  );
}
