import { useState } from "react";
import type {
  BankFinding,
  EvaluatorSettings,
  Json,
  Question,
} from "../contracts.js";
import { filterQuestions, questionType } from "./setup-draft.js";
import { AnswerSize } from "./answer-size.js";
import { Empty, json } from "./ui.js";

export function questionRuleSummary(
  settings: EvaluatorSettings,
  questionId: string,
): string {
  const rules = { ...settings, ...settings.questionOverrides[questionId] };
  if (rules.referenceDisposition === "needs_review")
    return "Excluded: reference needs review";
  if (rules.mode === "custom") return "Custom evaluator code";
  if (rules.mode === "exact") return "Exact value and ordering";
  const numeric =
    rules.decimalPlaces !== undefined
      ? `Round to ${rules.decimalPlaces} decimal places`
      : `Numeric tolerance ${rules.absoluteTolerance}; relative ${rules.relativeTolerance}`;
  if (rules.mode === "numeric") return numeric;
  if (rules.mode === "text")
    return rules.dateComparison
      ? rules.dateComparison === "calendar_date"
        ? "Compare calendar dates"
        : "Compare timestamps"
      : rules.caseSensitive
        ? "Match text capitalization"
        : "Ignore text capitalization";
  if (rules.mode === "json")
    return `Structured values; ${rules.arrayOrderMatters ? "ordered" : "unordered"} lists`;
  const parts = [numeric];
  parts.push(
    rules.caseSensitive
      ? "Match text capitalization"
      : "Ignore text capitalization",
  );
  parts.push(rules.arrayOrderMatters ? "Ordered lists" : "Unordered lists");
  parts.push(
    {
      expected: "Declared table ordering",
      ordered: "Ordered table rows",
      unordered: "Unordered table rows",
    }[rules.tableOrder],
  );
  return parts.join("; ");
}
function referenceSummary(answer: Json): string {
  if (Array.isArray(answer)) return `${answer.length} items`;
  if (answer !== null && typeof answer === "object") {
    if (Array.isArray(answer.rows)) return `${answer.rows.length} rows`;
    return "Structured answer";
  }
  return String(answer).slice(0, 100) || "Empty text";
}
export function BankQuestions({
  questions,
  settings,
  findings = [],
  onEdit,
  onAdd,
}: {
  questions: Question[];
  settings: EvaluatorSettings;
  findings?: BankFinding[];
  onEdit: (questionId: string) => void;
  onAdd: () => void;
}) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [tag, setTag] = useState("");
  const [rules, setRules] = useState("");
  const findingIds = new Set(
    findings
      .filter((item) => item.status === "open")
      .map((item) => item.questionId),
  );
  const visible = filterQuestions(questions, query, type, tag).filter(
    (question) =>
      !rules ||
      (rules === "overrides"
        ? Object.keys(settings.questionOverrides[question.id] ?? {}).length > 0
        : findingIds.has(question.id)),
  );
  return (
    <div className="panel-body stack">
      <div className="bank-toolbar">
        <input
          type="search"
          aria-label="Search questions"
          placeholder="Search questions, IDs, or tags"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          aria-label="Filter by answer type"
          value={type}
          onChange={(event) => setType(event.target.value)}
        >
          <option value="">All answer types</option>
          {[...new Set(questions.map(questionType))].sort().map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by tag"
          value={tag}
          onChange={(event) => setTag(event.target.value)}
        >
          <option value="">All tags</option>
          {[...new Set(questions.flatMap((item) => item.tags))]
            .sort()
            .map((item) => (
              <option key={item}>{item}</option>
            ))}
        </select>
        <select
          aria-label="Filter by grading rules"
          value={rules}
          onChange={(event) => setRules(event.target.value)}
        >
          <option value="">All grading rules</option>
          <option value="overrides">Question-specific rules</option>
          <option value="findings">With open findings</option>
        </select>
        <button className="button secondary" onClick={onAdd}>
          Add question
        </button>
      </div>
      <div className="question-table">
        <table>
          <thead>
            <tr>
              <th>Question</th>
              <th>Reference answer</th>
              <th>Grading</th>
              <th>Answer size</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((question) => (
              <tr key={question.id}>
                <td>
                  <button
                    className="bank-question-button"
                    onClick={() => onEdit(question.id)}
                  >
                    <span>{question.text}</span>
                    <small>
                      <span className="mono">{question.id}</span> -{" "}
                      {questionType(question)}
                      {findingIds.has(question.id) ? " - Open finding" : ""}
                    </small>
                  </button>
                  {question.tags.length > 0 && (
                    <div>
                      {question.tags.map((item) => (
                        <span className="tag" key={item}>
                          {item}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td>
                  <details className="answer-preview">
                    <summary aria-label={`Expected answer for ${question.id}`}>
                      {referenceSummary(question.expected)}
                    </summary>
                    <pre>
                      {typeof question.expected === "string"
                        ? question.expected
                        : json(question.expected)}
                    </pre>
                  </details>
                </td>
                <td>
                  <span className="tag">
                    {Object.keys(settings.questionOverrides[question.id] ?? {})
                      .length
                      ? "Question-specific rules"
                      : "Bank defaults"}
                  </span>
                  <p className="bank-rule-summary">
                    {questionRuleSummary(settings, question.id)}
                  </p>
                </td>
                <td>
                  <AnswerSize answer={question.expected} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!visible.length && (
        <Empty
          title={
            questions.length
              ? "No matching questions"
              : "Add your first question"
          }
        >
          Add questions with private references, or import a JSON or CSV file.
        </Empty>
      )}
      <p className="subtle">
        {visible.length} of {questions.length} question
        {questions.length === 1 ? "" : "s"}. Select a question to edit its
        answer and effective rules.
      </p>
    </div>
  );
}
