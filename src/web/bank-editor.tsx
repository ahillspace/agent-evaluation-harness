import { useState } from "react";
import type { BankRevision, Question } from "../contracts.js";
import { command } from "./api.js";
import { parseQuestions, replaceExpectedAnswer } from "./drafts.js";
import { AnswerFormatSummary } from "./answer-format.js";
import { ErrorNotice, Field, Icon, Modal, json } from "./ui.js";

export function BankEditor({
  source,
  onClose,
  onSaved,
}: {
  source: BankRevision | "new";
  onClose: () => void;
  onSaved: (value: BankRevision) => void;
}) {
  const [name, setName] = useState(source === "new" ? "" : source.name);
  const [questions, setQuestions] = useState<Question[]>(
    source === "new"
      ? [{ id: "q1", text: "", expected: "", tags: [] }]
      : source.questions,
  );
  const [mode, setMode] = useState("author");
  const [importText, setImportText] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const update = (index: number, changes: Partial<Question>) =>
    setQuestions((items) =>
      items.map((item, position) =>
        position === index ? { ...item, ...changes } : item,
      ),
    );
  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const payload = {
        name,
        questions: mode === "import" ? parseQuestions(importText) : questions,
      };
      const value =
        source === "new"
          ? await command("banks.create", payload)
          : await command("banks.revise", {
              ...payload,
              bankId: source.bankId,
            });
      onSaved(value);
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal
      title={
        source === "new"
          ? "Create question bank"
          : "Publish a new question revision"
      }
      onClose={onClose}
    >
      <ErrorNotice error={error} />
      <Field label="Bank name" required>
        <input
          aria-label="Bank name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Sales analytics"
        />
      </Field>
      <div
        className="tabs"
        role="tablist"
        aria-label="Question authoring method"
      >
        {["author", "import"].map((value) => (
          <button
            key={value}
            role="tab"
            aria-selected={mode === value}
            onClick={() => setMode(value)}
          >
            {value === "author" ? "Write questions" : "Import JSON or CSV"}
          </button>
        ))}
      </div>
      {mode === "import" ? (
        <div className="stack">
          <p className="subtle">
            JSON accepts a questions array or a bank export. CSV requires
            question and expected columns, with optional id and tags. Publishing
            a typed answer shares its public format with the target. Expected
            values and result counts stay private.
          </p>
          <input
            aria-label="Import question file"
            type="file"
            accept=".json,.csv"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void file.text().then(setImportText);
            }}
          />
          <textarea
            aria-label="Question import content"
            className="code-input"
            rows={13}
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
            placeholder={
              "id,question,expected\nq1,What was total revenue?,12500"
            }
          />
        </div>
      ) : (
        <div className="stack">
          {questions.map((question, index) => (
            <div key={index} className="question-editor">
              <div className="row">
                <span className="eyebrow">Question {index + 1}</span>
                <button
                  className="text-button danger"
                  disabled={questions.length === 1}
                  onClick={() =>
                    setQuestions((items) =>
                      items.filter((_, position) => index !== position),
                    )
                  }
                >
                  Remove
                </button>
              </div>
              <Field label="Question">
                <textarea
                  aria-label={`Question ${index + 1}`}
                  value={question.text}
                  rows={2}
                  onChange={(event) =>
                    update(index, { text: event.target.value })
                  }
                />
              </Field>
              <Field
                label="Expected answer"
                help="Enter plain text, a number, or a JSON value. Expected values stay private. For typed tables, publication records the declared column names, types, and null rules as the public answer format."
              >
                <textarea
                  aria-label={`Expected answer ${index + 1}`}
                  defaultValue={
                    typeof question.expected === "string"
                      ? question.expected
                      : json(question.expected)
                  }
                  rows={2}
                  onBlur={(event) => {
                    let value = event.target.value;
                    try {
                      value = JSON.parse(value);
                    } catch {
                      /* Preserve plain text. */
                    }
                    update(index, replaceExpectedAnswer(question, value));
                  }}
                />
              </Field>
              {question.answerFormat && (
                <AnswerFormatSummary format={question.answerFormat} />
              )}
              <div className="form-grid">
                <Field label="Question ID">
                  <input
                    aria-label={`Question ID ${index + 1}`}
                    value={question.id}
                    onChange={(event) =>
                      update(index, { id: event.target.value })
                    }
                  />
                </Field>
                <Field label="Tags">
                  <input
                    aria-label={`Tags ${index + 1}`}
                    value={question.tags.join(", ")}
                    onChange={(event) =>
                      update(index, {
                        tags: event.target.value
                          .split(",")
                          .map((value) => value.trim())
                          .filter(Boolean),
                      })
                    }
                    placeholder="revenue, aggregation"
                  />
                </Field>
              </div>
            </div>
          ))}
          <button
            className="button secondary"
            onClick={() =>
              setQuestions((items) => [
                ...items,
                {
                  id: `q${items.length + 1}`,
                  text: "",
                  expected: "",
                  tags: [],
                },
              ])
            }
          >
            <Icon name="plus" />
            Add question
          </button>
        </div>
      )}
      <footer className="modal-footer">
        <p>
          Publication creates an immutable revision. Existing runs keep their
          original questions.
        </p>
        <button
          className="button primary"
          disabled={pending || !name.trim()}
          onClick={() => {
            void submit();
          }}
        >
          {pending ? "Publishing..." : "Publish bank"}
        </button>
      </footer>
    </Modal>
  );
}
