import { useRef, useState, useEffect } from "react";
import {
  answerFormatSchema,
  questionSchema,
  type EvaluatorSettings,
  type Json,
  type Question,
  type Verdict,
} from "../contracts.js";
import { command } from "./api.js";
import { AnswerSize } from "./answer-size.js";
import { QuestionGradingFields } from "./question-grading.js";
import { ErrorNotice, Field, Modal, json } from "./ui.js";

function answerKind(value: Json): string {
  return typeof value === "number"
    ? "number"
    : typeof value === "string"
      ? "text"
      : "json";
}
function readAnswer(value: string, mode: string, label: string): Json {
  if (mode === "number") {
    if (!value.trim())
      throw new Error(`${label} cannot be blank. Enter a finite number.`);
    const number = Number(value);
    if (!Number.isFinite(number))
      throw new Error(`${label} must be a finite number.`);
    return number;
  }
  return mode === "json" ? (JSON.parse(value) as Json) : value;
}
export function BankEditor({
  question,
  settings,
  onClose,
  onSaved,
  onRemove,
}: {
  question: Question;
  settings: EvaluatorSettings;
  onClose: () => void;
  onSaved: (question: Question, settings: EvaluatorSettings) => void;
  onRemove?: () => void;
}) {
  const [value, setValue] = useState(question);
  const [rules, setRules] = useState(settings);
  const [reference, setReference] = useState(
    typeof question.expected === "string"
      ? question.expected
      : json(question.expected),
  );
  const [referenceMode, setReferenceMode] = useState(
    answerKind(question.expected),
  );
  const [format, setFormat] = useState(
    question.answerFormat ? json(question.answerFormat) : "",
  );
  const [sample, setSample] = useState("");
  const [sampleMode, setSampleMode] = useState(answerKind(question.expected));
  const [assessment, setAssessment] = useState<{
    key: string;
    verdict: Verdict;
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  const assessmentKey = JSON.stringify({
    value,
    rules,
    reference,
    referenceMode,
    format,
    sample,
    sampleMode,
  });
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const assemble = () => {
    const expected = readAnswer(reference, referenceMode, "Reference answer");
    return questionSchema.parse({
      ...value,
      expected,
      answerFormat: format.trim()
        ? answerFormatSchema.parse(JSON.parse(format))
        : undefined,
    });
  };
  const check = async () => {
    const request = ++generation.current;
    setError(null);
    setAssessment(null);
    setPending(true);
    try {
      const verdict = await command("banks.check-answer", {
        question: assemble(),
        settings: {
          ...rules,
          questionOverrides: {
            ...rules.questionOverrides,
            [value.id]: rules.questionOverrides[question.id] ?? {},
          },
        },
        answer: readAnswer(sample, sampleMode, "Sample answer"),
      });
      if (generation.current === request)
        setAssessment({ key: assessmentKey, verdict });
    } catch (cause) {
      if (generation.current === request) setError(cause);
    } finally {
      if (generation.current === request) setPending(false);
    }
  };
  return (
    <Modal title={`Question ${question.id}`} onClose={onClose}>
      <div className="bank-question-editor stack">
        <ErrorNotice error={error} />
        <section className="bank-editor-section stack">
          <h3>Question sent to the target</h3>
          <Field label="Question" required>
            <textarea
              aria-label="Question"
              rows={3}
              value={value.text}
              onChange={(event) =>
                setValue({ ...value, text: event.target.value })
              }
            />
          </Field>
          <details className="disclosure">
            <summary>Public context and answer instructions</summary>
            <div className="stack">
              <Field
                label="Public context"
                help="The target receives this context. Keep expected values and private criteria out of this field."
              >
                <textarea
                  aria-label="Public context"
                  rows={3}
                  value={value.context ?? ""}
                  onChange={(event) =>
                    setValue({
                      ...value,
                      context: event.target.value || undefined,
                    })
                  }
                />
              </Field>
              <Field
                label="Public answer instructions"
                help="Describe required precision, units, or ordering. Configure matching rules separately below; the evaluator does not infer rules from this text."
              >
                <textarea
                  aria-label="Public answer instructions"
                  rows={3}
                  value={value.evaluationGuidance ?? ""}
                  onChange={(event) =>
                    setValue({
                      ...value,
                      evaluationGuidance: event.target.value || undefined,
                    })
                  }
                />
              </Field>
              <Field
                label="Public answer format (JSON)"
                help='Leave blank to derive the public format at publication. For example: {"type":"scalar","valueType":"decimal","nullable":false}. Public formats contain structure, never reference values.'
              >
                <textarea
                  aria-label="Public answer format"
                  className="code-input"
                  rows={4}
                  value={format}
                  onChange={(event) => setFormat(event.target.value)}
                />
              </Field>
            </div>
          </details>
        </section>
        <section className="bank-editor-section stack">
          <h3>Private reference answer</h3>
          <p className="subtle">
            The evaluator and enabled judges receive the reference. The target
            never receives it.
          </p>
          <Field label="Reference value type">
            <select
              aria-label="Reference value type"
              value={referenceMode}
              onChange={(event) => {
                setReferenceMode(event.target.value);
                if (!sample) setSampleMode(event.target.value);
              }}
            >
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="json">JSON value</option>
            </select>
          </Field>
          <Field label="Reference answer">
            <textarea
              aria-label="Reference answer"
              rows={4}
              className={referenceMode === "json" ? "code-input" : undefined}
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
          </Field>
          <AnswerSize
            answer={
              referenceMode === "text"
                ? reference
                : (() => {
                    try {
                      return readAnswer(
                        reference,
                        referenceMode,
                        "Reference answer",
                      );
                    } catch {
                      return reference;
                    }
                  })()
            }
          />
        </section>
        <section className="bank-editor-section stack">
          <QuestionGradingFields
            questionId={question.id}
            settings={rules}
            onSettings={setRules}
          />
        </section>
        <section className="bank-editor-section stack">
          <h3>Try an answer</h3>
          <p className="subtle">
            This uses the engine's deterministic evaluator. It does not invoke a
            target or judge.
          </p>
          <Field label="Sample value type">
            <select
              aria-label="Sample value type"
              value={sampleMode}
              onChange={(event) => setSampleMode(event.target.value)}
            >
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="json">JSON value</option>
            </select>
          </Field>
          <Field label="Sample answer">
            <textarea
              aria-label="Sample answer"
              rows={3}
              value={sample}
              onChange={(event) => setSample(event.target.value)}
            />
          </Field>
          <button
            className="button secondary"
            disabled={pending}
            onClick={() => void check()}
          >
            {pending ? "Checking..." : "Check answer"}
          </button>
          {assessment?.key === assessmentKey && (
            <p className="notice" role="status">
              <strong>
                {assessment.verdict.status === "correct"
                  ? "Pass"
                  : assessment.verdict.status === "incorrect"
                    ? "Fail"
                    : assessment.verdict.status}
              </strong>
              : {assessment.verdict.explanation}
            </p>
          )}
        </section>
        <details className="disclosure">
          <summary>Question ID and tags</summary>
          <div className="form-grid">
            <Field label="Question ID">
              <input
                aria-label="Question ID"
                value={value.id}
                onChange={(event) =>
                  setValue({ ...value, id: event.target.value })
                }
              />
            </Field>
            <Field label="Tags">
              <input
                aria-label="Tags"
                value={value.tags.join(", ")}
                onChange={(event) =>
                  setValue({
                    ...value,
                    tags: event.target.value
                      .split(",")
                      .map((tag) => tag.trim())
                      .filter(Boolean),
                  })
                }
              />
            </Field>
          </div>
        </details>
        {onRemove && (
          <details className="disclosure">
            <summary>Remove question</summary>
            <p className="subtle">
              Remove this question and its evaluator overrides from the draft.
              Earlier published revisions stay available.
            </p>
            <button className="button danger" onClick={onRemove}>
              Remove from draft
            </button>
          </details>
        )}
      </div>
      <footer className="modal-footer">
        <p>Save into this bank's draft, then review and publish the changes.</p>
        <div className="actions">
          <button className="button secondary" onClick={onClose}>
            Discard edits
          </button>
          <button
            className="button primary"
            onClick={() => {
              setError(null);
              try {
                onSaved(assemble(), rules);
              } catch (cause) {
                setError(cause);
              }
            }}
          >
            Save draft
          </button>
        </div>
      </footer>
    </Modal>
  );
}
