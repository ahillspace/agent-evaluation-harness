import type { AnswerFormat } from "../contracts.js";

export function AnswerFormatSummary({ format }: { format?: AnswerFormat }) {
  return (
    <details className="disclosure">
      <summary>Public answer format</summary>
      {format ? (
        <div className="stack">
          <p>
            The target receives these format requirements. Expected values stay
            private.
          </p>
          <p className="subtle">
            The evaluator checks submitted values independently.
          </p>
          {format.type === "table" ? (
            <>
              <table>
                <thead>
                  <tr>
                    <th>Column</th>
                    <th>Type</th>
                    <th>Null values</th>
                  </tr>
                </thead>
                <tbody>
                  {format.columns.map((column) => (
                    <tr key={column.name}>
                      <td>{column.name}</td>
                      <td>{column.type}</td>
                      <td>
                        {column.nullable ? "Null permitted" : "Value required"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="subtle">
                Submit an array of row objects using these exact column names.
                Column order does not change their meaning.
              </p>
            </>
          ) : (
            <p>
              {format.type === "scalar"
                ? `Single ${format.valueType} value`
                : `List of ${format.itemType} values`}
              .{" "}
              {format.nullable ? "Null permitted" : "Non-null values required"}.
            </p>
          )}
        </div>
      ) : (
        <p>No public answer format is recorded for this question.</p>
      )}
    </details>
  );
}
