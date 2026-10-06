import { useState } from "react";
import type { BankFinding, RunView } from "../contracts.js";
import { command } from "./api.js";
import { ErrorNotice, Field, Modal } from "./ui.js";

export function ReportFinding({
  view,
  resultId,
  passId,
  bankRevisionId,
  onClose,
}: {
  view: RunView;
  resultId: string;
  passId?: string;
  bankRevisionId?: string;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [kind, setKind] = useState<BankFinding["kind"]>("reference");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const result = view.results.find((item) => item.id === resultId);
  return (
    <Modal title="Report a question finding" onClose={onClose}>
      <p className="subtle">
        Save a suspected question or reference problem for review in the
        question bank. This run supplies the evidence.
      </p>
      <ErrorNotice error={error} />
      <div className="stack">
        <Field label="Finding">
          <input
            aria-label="Finding"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Describe the suspected problem"
          />
        </Field>
        <Field label="Type">
          <select
            aria-label="Finding type"
            value={kind}
            onChange={(event) => setKind(event.target.value as typeof kind)}
          >
            <option value="reference">Expected answer</option>
            <option value="ambiguity">Ambiguous instructions</option>
            <option value="duplicates">Repeated values</option>
            <option value="datasource">Datasource</option>
          </select>
        </Field>
        <Field label="Evidence and suggested correction">
          <textarea
            aria-label="Evidence and suggested correction"
            value={note}
            rows={5}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
        <button
          className="button primary"
          disabled={pending || !title.trim() || !result}
          onClick={() => {
            if (!result) return;
            setPending(true);
            void command("banks.report-finding", {
              bankId: view.run.manifest.bank.bankId,
              bankRevisionId: bankRevisionId ?? view.run.manifest.bank.id,
              questionId: result.questionId,
              kind,
              title,
              note,
              runId: view.run.id,
              resultId,
              passId,
            })
              .then(onClose)
              .catch(setError)
              .finally(() => setPending(false));
          }}
        >
          {pending ? "Saving finding..." : "Save to question bank"}
        </button>
      </div>
    </Modal>
  );
}
