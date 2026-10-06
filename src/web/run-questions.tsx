import { useState } from "react";
import type { BankRevision, WorkspaceView } from "../contracts.js";
import type { SetupDraftProps } from "./setup-types.js";
import { Field } from "./ui.js";
import {
  filterQuestions,
  questionType,
  selectedQuestionIds,
} from "./setup-draft.js";
import { expectedAnswerSize } from "../contracts/answer-size.js";
import { AnswerSize } from "./answer-size.js";

export function RunQuestions({
  draft,
  set,
  setDraft,
  bank,
  published,
  workspace,
}: SetupDraftProps & {
  bank?: BankRevision;
  published: Array<{ id: string; name: string; number: number; count: number }>;
  workspace: Pick<WorkspaceView, "banks" | "connections">;
}) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [tag, setTag] = useState("");
  const [minimum, setMinimum] = useState(0);
  const [maximum, setMaximum] = useState<number | undefined>();
  const questions = bank?.questions ?? [];
  const upper = Math.max(
    1,
    ...questions.map(
      (question) => expectedAnswerSize(question.expected).tokens,
    ),
  );
  const max = maximum ?? upper;
  const visible = filterQuestions(questions, query, type, tag).filter(
    (question) => {
      const size = expectedAnswerSize(question.expected).tokens;
      return size >= minimum && size <= max;
    },
  );
  const selected = new Set(selectedQuestionIds(draft, questions));
  const select = (ids: string[]) =>
    setDraft((value) => ({
      ...value,
      questionSelection: "selected",
      questionIds: [...new Set(ids)],
    }));
  return (
    <>
      <Field label="Run name" required>
        <input
          aria-label="Run name"
          value={draft.name}
          onChange={(event) => set("name", event.target.value)}
        />
      </Field>
      <Field label="Question bank" required>
        <select
          aria-label="Question bank"
          value={draft.bankRevisionId}
          onChange={(event) => {
            const chosen = workspace.banks.find(
              (item) => item.latestRevisionId === event.target.value,
            );
            setDraft((value) => ({
              ...value,
              bankId: chosen?.id ?? draft.bankId,
              bankRevisionId: event.target.value,
              evaluatorRevisionId: chosen?.activeEvaluatorRevisionId ?? "",
              jevSelection: {
                ...value.jevSelection,
                profileRevisionId: chosen?.activeJevProfileRevisionId,
              },
              questionSelection: "all",
              questionIds: [],
            }));
            setQuery("");
            setType("");
            setTag("");
            setMinimum(0);
            setMaximum(undefined);
          }}
        >
          <option value="">Choose a bank</option>
          {published.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · revision {item.number} · {item.count} questions
            </option>
          ))}
        </select>
      </Field>
      {bank && (
        <div className="stack">
          <div className="row">
            <h3>Question selection</h3>
            <div className="actions">
              <button
                className="text-button"
                onClick={() =>
                  setDraft((value) => ({
                    ...value,
                    questionSelection: "all",
                    questionIds: [],
                  }))
                }
              >
                Use all {questions.length}
              </button>
              <button className="text-button" onClick={() => select([])}>
                Deselect all
              </button>
            </div>
          </div>
          <p className="subtle">
            {selected.size} selected · {visible.length} visible. Filters change
            visibility only.
          </p>
          {!selected.size && (
            <p className="notice">
              Select at least one question before launching.
            </p>
          )}
          <Field label="Search questions">
            <input
              type="search"
              aria-label="Search questions"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Question text, ID, or tag"
            />
          </Field>
          <div className="form-grid">
            <Field label="Answer type">
              <select
                aria-label="Question answer type"
                value={type}
                onChange={(event) => setType(event.target.value)}
              >
                <option value="">All types</option>
                {[...new Set(questions.map(questionType))]
                  .sort()
                  .map((value) => (
                    <option key={value}>{value}</option>
                  ))}
              </select>
            </Field>
            <Field label="Tag">
              <select
                aria-label="Question tag"
                value={tag}
                onChange={(event) => setTag(event.target.value)}
              >
                <option value="">All tags</option>
                {[...new Set(questions.flatMap((question) => question.tags))]
                  .sort()
                  .map((value) => (
                    <option key={value}>{value}</option>
                  ))}
              </select>
            </Field>
          </div>
          <details className="disclosure">
            <summary>Filter expected answer size</summary>
            <div className="stack">
              <p className="subtle">
                Approximate tokens in the expected answer. Judge requests also
                include instructions, the actual answer, and evidence.
              </p>
              <Field
                label={
                  "Minimum expected answer tokens: " + minimum.toLocaleString()
                }
              >
                <input
                  aria-label="Minimum expected answer tokens"
                  type="range"
                  min={0}
                  max={upper}
                  step={1}
                  value={minimum}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setMinimum(value);
                    if (value > max) setMaximum(value);
                  }}
                />
              </Field>
              <Field
                label={
                  "Maximum expected answer tokens: " + max.toLocaleString()
                }
              >
                <input
                  aria-label="Maximum expected answer tokens"
                  type="range"
                  min={0}
                  max={upper}
                  step={1}
                  value={max}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setMaximum(value);
                    if (value < minimum) setMinimum(value);
                  }}
                />
              </Field>
              <button
                className="text-button"
                onClick={() => {
                  setMinimum(0);
                  setMaximum(undefined);
                }}
              >
                Reset size filters
              </button>
            </div>
          </details>
          <div className="actions">
            <button
              className="text-button"
              onClick={() =>
                select([...selected, ...visible.map((question) => question.id)])
              }
            >
              Select filtered
            </button>
            <button
              className="text-button"
              onClick={() => {
                const shown = new Set(visible.map((question) => question.id));
                select([...selected].filter((id) => !shown.has(id)));
              }}
            >
              Deselect filtered
            </button>
          </div>
          <div className="selection-list">
            {visible.map((question) => (
              <label key={question.id} className="check-row">
                <input
                  type="checkbox"
                  checked={selected.has(question.id)}
                  onChange={(event) =>
                    select(
                      event.target.checked
                        ? [...selected, question.id]
                        : [...selected].filter((id) => id !== question.id),
                    )
                  }
                />
                <span>
                  {question.text}
                  <small>
                    {question.id} · {questionType(question)}
                    {question.tags.length
                      ? " · " + question.tags.join(", ")
                      : ""}
                  </small>
                  <AnswerSize answer={question.expected} />
                </span>
              </label>
            ))}
          </div>
          {!visible.length && (
            <p className="subtle">No questions match these filters.</p>
          )}
        </div>
      )}
    </>
  );
}
