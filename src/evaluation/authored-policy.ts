import type { EvaluatorSettings, Json } from "../contracts.js";

/** Publication checks do not change the interpretation of immutable historical settings. */
export function validateAuthoredPolicy(
  expected: Json,
  settings: EvaluatorSettings,
): void {
  const reference =
    expected !== null &&
    typeof expected === "object" &&
    !Array.isArray(expected)
      ? expected
      : undefined;
  const table = reference?.type === "table" ? reference : undefined;
  const policies = [
    settings.sortOrder && "Sorting",
    settings.duplicateRows === "distinct" && "Distinct rows",
    Object.keys(settings.columnAliases).length > 0 && "Column aliases",
    settings.allowColumnPermutation && "Column permutation",
    settings.tableOrder !== "expected" && "Table ordering",
    settings.orderBy !== undefined && "Ordering keys",
    settings.collation && "Collation",
  ].filter(Boolean);
  if (policies.length && (settings.mode !== "auto" || !table))
    throw new Error(
      `${policies.join(", ")} require Auto comparison with a typed table.`,
    );
  if (!table) return;
  if (
    settings.orderBy &&
    (settings.sortOrder ||
      settings.topK ||
      !(
        settings.tableOrder === "ordered" ||
        (settings.tableOrder === "expected" && table.ordered === true)
      ))
  )
    throw new Error(
      "Ordering keys require ordered table comparison without explicit sorting or top-k.",
    );
  if (settings.topK && settings.tableOrder !== "expected")
    throw new Error(
      "Table ordering is superseded by top-k ordering; use the expected table-order setting.",
    );
  if (settings.collation) {
    const keys = settings.sortOrder ?? settings.topK?.orderBy;
    const columns = table.columns as Array<{ name: string; type: string }>;
    if (
      !keys?.some((key) => {
        const column = columns.find((item) => item.name === key.column)!;
        return (
          !["integer", "decimal", "date", "datetime"].includes(column.type) &&
          !settings.columnRules?.[column.name]?.dateComparison
        );
      })
    )
      throw new Error(
        "Collation requires explicit sorting or top-k with a nonnumeric, nontemporal ordering column.",
      );
  }
}
