import type { Json } from "../contracts.js";
type ObjectValue = Record<string, Json>;
const object = (value: Json): value is ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function columnAliasMap(
  columns: string[],
  configured: Record<string, string[]>,
): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const [canonical, names] of Object.entries(configured)) {
    if (!columns.includes(canonical))
      throw new Error(
        `Column alias target ${canonical} is not a declared expected column.`,
      );
    for (const name of names) {
      if (columns.includes(name) || aliases.has(name))
        throw new Error(
          "Column aliases must map unambiguously to one declared column.",
        );
      aliases.set(name, canonical);
    }
  }
  return aliases;
}

export function renameSubmittedColumns(
  answer: ObjectValue,
  aliases: Map<string, string>,
): ObjectValue {
  if (!aliases.size) return answer;
  const rows = Array.isArray(answer.rows)
    ? answer.rows.map((row) => {
        if (!object(row)) return row;
        const entries = Object.entries(row).map(
          ([key, value]) => [aliases.get(key) ?? key, value] as const,
        );
        if (new Set(entries.map(([key]) => key)).size !== entries.length)
          throw new Error(
            "A row supplies more than one name for the same column.",
          );
        return Object.fromEntries(entries);
      })
    : answer.rows;
  const columns = Array.isArray(answer.columns)
    ? answer.columns.map((column) =>
        object(column) && typeof column.name === "string"
          ? { ...column, name: aliases.get(column.name) ?? column.name }
          : column,
      )
    : answer.columns;
  return {
    ...answer,
    ...(rows === undefined ? {} : { rows }),
    ...(columns === undefined ? {} : { columns }),
  };
}
