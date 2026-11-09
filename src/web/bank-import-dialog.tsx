import { useEffect, useRef, useState } from "react";
import { parseBankImport, type BankImport } from "./bank-import.js";
import { ErrorNotice, Field, Modal } from "./ui.js";

export function BankImportDialog({
  pristine,
  importError,
  onClearImportError,
  onClose,
  onImport,
}: {
  pristine: boolean;
  importError: unknown;
  onClearImportError: () => void;
  onClose: () => void;
  onImport: (value: BankImport, mode: "replace" | "append") => void;
}) {
  const [source, setSource] = useState("");
  const [mode, setMode] = useState<"replace" | "append">(
    pristine ? "replace" : "append",
  );
  const [reading, setReading] = useState(false);
  const readVersion = useRef(0);
  useEffect(
    () => () => {
      readVersion.current++;
    },
    [],
  );
  const [error, setError] = useState<unknown>(null);
  const change = (value: string) => {
    readVersion.current++;
    setReading(false);
    setSource(value);
    setError(null);
    onClearImportError();
  };
  const importSource = (value: string) => {
    setError(null);
    onClearImportError();
    try {
      onImport(parseBankImport(value), mode);
    } catch (cause) {
      setError(cause);
    }
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
    <Modal
      title="Import questions"
      onClose={() => {
        readVersion.current++;
        onClose();
      }}
    >
      <div className="stack">
        <p>Choose a file to import into this draft, or paste content below.</p>
        <p className="subtle">
          CSV accepts question, expected, optional id, and tags separated by |.
          Versioned JSON packages preserve shared rules and question overrides.
        </p>
        <button className="button secondary" onClick={template}>
          Download CSV template
        </button>
        {!pristine && (
          <Field label="Import action">
            <select
              aria-label="Import action"
              value={mode}
              disabled={reading}
              onChange={(event) => {
                setMode(event.target.value as "replace" | "append");
                setError(null);
                onClearImportError();
              }}
            >
              <option value="append">Add to this draft</option>
              <option value="replace">
                Replace draft questions and imported rules
              </option>
            </select>
            <p className="subtle">
              {mode === "append"
                ? "Keeps current shared rules and imports question-specific overrides."
                : "Replaces draft questions and imports the package's full grading rules."}
            </p>
          </Field>
        )}
        <input
          type="file"
          aria-label="Import question file"
          accept=".csv,.json"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            event.target.value = "";
            const version = ++readVersion.current;
            setReading(true);
            setError(null);
            onClearImportError();
            try {
              const value = await file.text();
              if (version !== readVersion.current) return;
              setReading(false);
              setSource(value);
              importSource(value);
            } catch (cause) {
              if (version !== readVersion.current) return;
              setReading(false);
              setError(cause);
            }
          }}
        />
        {reading && <p role="status">Reading question file...</p>}
        <Field label="Question import content">
          <textarea
            aria-label="Question import content"
            className="code-input"
            rows={10}
            value={source}
            onChange={(event) => change(event.target.value)}
          />
        </Field>
        <ErrorNotice error={error ?? importError} />
        <footer className="modal-footer">
          <p>Import changes the draft. Review before publishing.</p>
          <button
            className="button primary"
            disabled={reading || !source.trim()}
            onClick={() => importSource(source)}
          >
            Import into draft
          </button>
        </footer>
      </div>
    </Modal>
  );
}
