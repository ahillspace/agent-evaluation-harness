import type { EvaluationPreview, Verdict } from "../contracts.js";
import { JsonView } from "./ui.js";
import { Answer } from "./answer.js";
import { CalibrationResults } from "./calibration-results.js";

const label = (value?: Verdict) =>
  value === undefined
    ? "Not recorded"
    : {
        correct: "Pass",
        incorrect: "Fail",
        error: "Evaluation error",
        unavailable: "Unavailable",
        unscorable: "Unscorable",
      }[value.status];
export function EvaluatorPreview({ preview }: { preview: EvaluationPreview }) {
  const changed = preview.runs.reduce(
    (sum, run) => sum + run.rows.filter((row) => row.changed).length,
    0,
  );
  const total = preview.runs.reduce((sum, run) => sum + run.rows.length, 0);
  return (
    <section className="preview-results">
      <div className="notice">
        <div>
          <strong>
            {changed === 0
              ? "No score changes"
              : `${changed} assessment${changed === 1 ? "" : "s"} changed`}
          </strong>
          <p>
            {total} saved answers reviewed across {preview.runs.length} runs.
            This draft is not published.
          </p>
        </div>
      </div>
      {preview.referenceBank && (
        <p className="notice">
          {preview.referenceBank.number === 0
            ? `Draft references: ${preview.referenceBank.name}.`
            : `Corrected references: ${preview.referenceBank.name}, revision ${preview.referenceBank.number}.`}{" "}
          Original run references remain unchanged.
        </p>
      )}
      {preview.calibration && (
        <CalibrationResults report={preview.calibration} />
      )}
      {preview.runs.map((run) => (
        <div key={run.runId} className="preview-run">
          <h3>{run.name}</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Question</th>
                  <th>Submitted answer</th>
                  <th>Original</th>
                  <th>Draft</th>
                  <th>Explanation</th>
                </tr>
              </thead>
              <tbody>
                {run.rows.map((row) => (
                  <tr
                    key={row.resultId}
                    className={row.changed ? "preview-changed" : ""}
                  >
                    <td>
                      <strong>{row.question}</strong>
                      <small>
                        {row.questionId} · Repetition {row.repetition}
                        {row.changed ? " · Changed" : ""}
                      </small>
                    </td>
                    <td>
                      {row.answer !== undefined &&
                      (typeof row.answer === "object" ||
                        String(row.answer).length > 160) ? (
                        <details className="disclosure">
                          <summary>View submitted answer</summary>
                          <Answer value={row.answer} />
                        </details>
                      ) : (
                        <Answer value={row.answer} />
                      )}
                    </td>
                    <td>
                      <span
                        className={`verdict-label ${row.before?.status ?? "unavailable"}`}
                      >
                        {label(row.before)}
                      </span>
                    </td>
                    <td>
                      <span className={`verdict-label ${row.after.status}`}>
                        {label(row.after)}
                      </span>
                    </td>
                    <td>
                      {row.after.explanation}
                      {row.expected !== undefined && preview.referenceBank && (
                        <details className="disclosure">
                          <summary>Selected reference answer</summary>
                          <Answer value={row.expected} />
                        </details>
                      )}
                      {row.changed &&
                        row.before &&
                        row.before.explanation !== row.after.explanation && (
                          <small>Previously: {row.before.explanation}</small>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {run.rows.length === 0 && (
            <p className="subtle">
              No saved answers are available for this run.
            </p>
          )}
        </div>
      ))}
      <details className="disclosure">
        <summary>Preview record details</summary>
        <JsonView value={preview} />
      </details>
    </section>
  );
}
