import { useState } from "react";
import { parseBankImport, type BankImport } from "./bank-import.js";
import { ErrorNotice, Field, Modal } from "./ui.js";

export function BankImportDialog({
  onClose,
  onImport,
}: {
  onClose: () => void;
  onImport: (value: BankImport, mode: "replace" | "append") => void;
}) {
  const [source, setSource] = useState("");
  const [mode, setMode] = useState<"replace" | "append">("append");
  const [reviewed, setReviewed] = useState<BankImport | null>(null);
  const [error, setError] = useState<unknown>(null);
  const change = (value: string) => {
    setSource(value);
    setReviewed(null);
    setError(null);
  };
  const template = () => {
    const url = URL.createObjectURL(
      new Blob(
        ['id,question,expected,tags\nq1,"What is the total?",42,demo\n'],
        { type: "text/csv" },
      ),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "question-bank-template.csv";
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Modal title="Import questions" onClose={onClose}>
      <div className="stack">
        <p className="subtle">
          CSV accepts question, expected, optional id, and tags separated by |.
          Versioned JSON packages preserve shared rules and question overrides.
        </p>
        <button className="button secondary" onClick={template}>
          Download CSV template
        </button>
        <input
          type="file"
          aria-label="Import question file"
          accept=".csv,.json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void file.text().then(change).catch(setError);
          }}
        />
        <Field label="Question import content">
          <textarea
            aria-label="Question import content"
            className="code-input"
            rows={10}
            value={source}
            onChange={(event) => change(event.target.value)}
          />
        </Field>
        <Field label="Import action">
          <select
            aria-label="Import action"
            value={mode}
            onChange={(event) =>
              setMode(event.target.value as "replace" | "append")
            }
          >
            <option value="append">Add to this draft</option>
            <option value="replace">
              Replace draft questions and imported rules
            </option>
          </select>
        </Field>
        <ErrorNotice error={error} />
        {reviewed && (
          <div className="bank-import-preview notice">
            <strong>{reviewed.questions.length} validated questions</strong>
            <p>
              {reviewed.evaluator
                ? `Includes evaluator: ${reviewed.evaluator.name}. Replace mode imports its full rules; append mode keeps current shared rules and imports question-specific overrides.`
                : "Shared grading rules stay unchanged."}
            </p>
            {reviewed.jevProfile && (
              <p>
                Includes Jev profile: {reviewed.jevProfile.name}. Review and
                publish this profile separately after importing; it does not
                become active automatically.
              </p>
            )}
          </div>
        )}
        <footer className="modal-footer">
          <p>Import changes the draft. Review before publishing.</p>
          <button
            className="button secondary"
            onClick={() => {
              setError(null);
              try {
                setReviewed(parseBankImport(source));
              } catch (cause) {
                setError(cause);
              }
            }}
          >
            Review import
          </button>
          <button
            className="button primary"
            disabled={!reviewed}
            onClick={() => {
              if (reviewed) {
                try {
                  onImport(reviewed, mode);
                } catch (cause) {
                  setError(cause);
                }
              }
            }}
          >
            Import into draft
          </button>
        </footer>
      </div>
    </Modal>
  );
}
