import type { EvaluatorSettings, Json } from "../contracts.js";

/** Describe public acceptance rules without reference answers or evaluator code. */
export function publicEvaluationGuidance(
  settings: EvaluatorSettings,
  expected?: Json,
): string {
  const rules = [
    settings.representationPolicy === "strict"
      ? "Submit the declared answer format exactly."
      : "Submit the declared answer shape. Equivalent saved representations can be accepted when they preserve answer content.",
    settings.duplicateRows === "distinct"
      ? "Repeated identical rows are treated as one distinct row."
      : "Preserve duplicate rows and their multiplicity.",
  ];
  if (settings.sortOrder?.length)
    rules.push(
      `Sort rows by ${settings.sortOrder.map((s) => `${s.column} ${s.direction}`).join(", ")}.`,
    );
  else if (settings.tableOrder === "unordered")
    rules.push("Row order does not affect grading.");
  else if (settings.tableOrder === "ordered")
    rules.push("Row order is part of the answer requirements.");
  else if (
    settings.tableOrder === "expected" &&
    expected !== null &&
    typeof expected === "object" &&
    !Array.isArray(expected) &&
    expected?.ordered === true
  )
    rules.push(
      `Row order is required${Array.isArray(expected.order_by) ? ` by ${expected.order_by.join(", ")}` : ""}.`,
    );
  if (settings.collation)
    rules.push(
      `Sorting uses locale ${settings.collation.locale}, numeric ordering ${settings.collation.numeric}, punctuation ignored ${settings.collation.ignorePunctuation}, sensitivity ${settings.collation.sensitivity}.`,
    );
  rules.push(
    `Text comparison is ${settings.caseSensitive ? "case sensitive" : "case insensitive"}; whitespace ${settings.collapseWhitespace ? "is normalized" : settings.trimWhitespace ? "is trimmed" : "is preserved"}.`,
  );
  rules.push(
    `Numeric tolerance: absolute ${settings.absoluteTolerance}, relative ${settings.relativeTolerance}${settings.decimalPlaces === undefined ? "" : `, rounded to ${settings.decimalPlaces} decimal places`}.`,
  );
  if (settings.columnRules)
    rules.push(
      `Column comparison rules: ${JSON.stringify(settings.columnRules)}.`,
    );
  return rules.join(" ");
}
