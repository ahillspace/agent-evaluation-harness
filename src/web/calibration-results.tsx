import type { CalibrationReport } from "../contracts.js";

export function CalibrationResults({ report }: { report: CalibrationReport }) {
  return (
    <section className="preview-results">
      <div
        className={`notice ${report.passed === report.total ? "" : "error"}`}
      >
        <div>
          <strong>
            {report.passed} / {report.total} calibration cases agree
          </strong>
          <p>
            Cases test the evaluator against known acceptable and unacceptable
            answers. Failed cases block publication.
          </p>
          <details className="disclosure">
            <summary>Calibration reference record</summary>
            <p className="subtle">{report.bankRevisionId}</p>
          </details>
        </div>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Case</th>
              <th>Expected verdict</th>
              <th>Actual verdict</th>
              <th>Explanation</th>
            </tr>
          </thead>
          <tbody>
            {report.results.map((result) => (
              <tr
                key={result.id}
                className={result.passed ? "" : "preview-changed"}
              >
                <td>
                  <strong>{result.id}</strong>
                  <small>
                    {result.questionId} -{" "}
                    {result.passed ? "Agrees" : "Failed case"}
                  </small>
                </td>
                <td>{result.expectedStatus}</td>
                <td>{result.actual.status}</td>
                <td>{result.actual.explanation}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {report.total === 0 && (
        <p className="subtle">
          No calibration cases are configured. Add both accepted equivalents and
          nearby wrong answers.
        </p>
      )}
    </section>
  );
}
