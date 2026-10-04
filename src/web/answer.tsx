import type { Json } from "../contracts.js";
import { JsonView, title } from "./ui.js";

function record(value: Json): value is Record<string, Json> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function display(value: Json | undefined): string {
  return value === undefined
    ? "Not recorded"
    : value === null
      ? "NULL"
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
}

function AnswerTable({
  columns,
  rows,
  original,
}: {
  columns: string[];
  rows: Record<string, Json>[];
  original: Json;
}) {
  return (
    <div className="typed-answer">
      <div className="table-scroll">
        <table className="answer-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th scope="col" key={column}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {columns.map((column) => (
                  <td key={column}>{display(row[column])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <small>{rows.length} recorded rows</small>
      <details className="disclosure">
        <summary>Recorded answer JSON</summary>
        <JsonView value={original} />
      </details>
    </div>
  );
}

export function Answer({ value }: { value: Json | undefined }) {
  if (value === undefined) return <span className="subtle">Not recorded</span>;
  if (value === null) return <span className="answer-value mono">NULL</span>;
  if (typeof value !== "object")
    return <div className="answer-value">{String(value)}</div>;
  if (Array.isArray(value) && value.length > 0 && value.every(record)) {
    const columns = Object.keys(value[0]!);
    const flat =
      columns.length > 0 &&
      value.every(
        (row) =>
          Object.keys(row).length === columns.length &&
          columns.every(
            (column) =>
              Object.hasOwn(row, column) &&
              (row[column] === null || typeof row[column] !== "object"),
          ),
      );
    if (flat)
      return <AnswerTable columns={columns} rows={value} original={value} />;
  }
  if (record(value)) {
    if (
      (value.type === "numeric" || value.type === "string") &&
      Object.hasOwn(value, "value")
    )
      return (
        <div className="typed-answer">
          <span className="tag">{value.type}</span>
          <div className="answer-value">{display(value.value)}</div>
          {Array.isArray(value.aliases) && value.aliases.length > 0 && (
            <p className="subtle">
              Accepted aliases: {value.aliases.map(display).join(", ")}
            </p>
          )}
        </div>
      );
    if (
      typeof value.type === "string" &&
      ["empty_table", "null_scalar", "unanswerable", "clarification"].includes(
        value.type,
      )
    )
      return (
        <div className="typed-answer">
          <span className="tag">{title(value.type)}</span>
          {typeof value.reason === "string" && <p>{value.reason}</p>}
        </div>
      );
    if (
      value.type === "table" &&
      Array.isArray(value.columns) &&
      value.columns.every(
        (column) => record(column) && typeof column.name === "string",
      ) &&
      Array.isArray(value.rows) &&
      value.rows.every(record)
    ) {
      const columns = value.columns as Array<Record<string, Json>>;
      const rows = value.rows as Array<Record<string, Json>>;
      return (
        <AnswerTable
          columns={columns.map((column) => String(column.name))}
          rows={rows}
          original={value}
        />
      );
    }
  }
  return <JsonView value={value} />;
}
