import type {
  AnswerFormat,
  EvaluatorSettings,
  Json,
  Verdict,
} from "../contracts.js";
import {
  decimalsMatch,
  isIntegerDecimal,
  parseDecimal,
  roundedDecimalsMatch,
  compareDecimals,
} from "./decimal.js";
import { temporalValue } from "../contracts/temporal.js";
import { rowsMatch } from "./row-matching.js";
import { columnAliasMap, renameSubmittedColumns } from "./column-aliases.js";
import { validateEvaluationFormat } from "./submission-format.js";
import { referenceAnswerValue } from "../contracts/answer-format.js";

type ObjectValue = { [key: string]: Json };
type Settings = EvaluatorSettings;
interface Column {
  name: string;
  type: string;
  nullable: boolean;
}
interface Table {
  columns: Column[];
  rows: ObjectValue[];
}
const states = new Set([
  "empty_table",
  "null_scalar",
  "unanswerable",
  "clarification",
]);
const types = new Set([
  "string",
  "decimal",
  "integer",
  "boolean",
  "date",
  "datetime",
]);
const record = (value: Json): value is ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const verdict = (
  correct: boolean,
  explanation: string,
  details?: Json,
): Verdict => ({
  status: correct ? "correct" : "incorrect",
  explanation,
  ...(!correct
    ? { details: details ?? { reason: "value_mismatch", path: "" } }
    : {}),
});

function normalized(value: string, settings: Settings): string {
  let result = value.normalize("NFKC");
  if (settings.trimWhitespace) result = result.trim();
  if (settings.collapseWhitespace) result = result.replace(/\s+/gu, " ");
  return settings.caseSensitive ? result : result.toLocaleLowerCase("en-US");
}

function dateValue(value: Json, dateOnly: boolean): string | undefined {
  return temporalValue(value, dateOnly ? "date" : "datetime");
}

function validCell(value: Json, column: Column): boolean {
  if (value === null) return column.nullable;
  if (column.type === "decimal") return parseDecimal(value) !== undefined;
  if (column.type === "integer") return isIntegerDecimal(value);
  if (column.type === "date" || column.type === "datetime")
    return dateValue(value, column.type === "date") !== undefined;
  return typeof value === column.type;
}

function readTable(value: ObjectValue): Table {
  if (
    !Array.isArray(value.columns) ||
    !value.columns.length ||
    value.columns.length > 100 ||
    !Array.isArray(value.rows) ||
    value.rows.length > 1000
  ) {
    throw new Error(
      "A typed table requires 1-100 columns and at most 1,000 rows.",
    );
  }
  const names = new Set<string>();
  const columns = value.columns.map((column): Column => {
    if (
      !record(column) ||
      typeof column.name !== "string" ||
      !column.name ||
      typeof column.type !== "string" ||
      !types.has(column.type) ||
      names.has(column.name)
    )
      throw new Error(
        "Table columns require unique names and supported types.",
      );
    if (column.nullable !== undefined && typeof column.nullable !== "boolean")
      throw new Error("Column nullable must be a boolean.");
    names.add(column.name);
    return {
      name: column.name,
      type: column.type,
      nullable: column.nullable === true,
    };
  });
  const rows = value.rows.map((row) => {
    if (
      !record(row) ||
      Object.keys(row).length !== columns.length ||
      columns.some(
        (column) =>
          !Object.hasOwn(row, column.name) ||
          !validCell(row[column.name]!, column),
      )
    )
      throw new Error(
        "Table rows must satisfy every declared column, type, and null rule.",
      );
    return row;
  });
  return { columns, rows };
}

function cellMatches(
  expected: Json,
  actual: Json,
  column: Column,
  settings: Settings,
): boolean {
  settings = { ...settings, ...settings.columnRules?.[column.name] };
  if (expected === null || actual === null) return expected === actual;
  if (column.type === "integer" && !isIntegerDecimal(actual)) return false;
  if (
    settings.dateComparison &&
    ["string", "date", "datetime"].includes(column.type)
  ) {
    const reference = temporalValue(expected, settings.dateComparison);
    return (
      reference !== undefined &&
      reference === temporalValue(actual, settings.dateComparison)
    );
  }
  if (column.type === "decimal" || column.type === "integer")
    return settings.decimalPlaces !== undefined
      ? roundedDecimalsMatch(expected, actual, settings.decimalPlaces)
      : decimalsMatch(
          expected,
          actual,
          settings.absoluteTolerance,
          settings.relativeTolerance,
        );
  if (column.type === "string")
    return (
      typeof expected === "string" &&
      typeof actual === "string" &&
      normalized(expected, settings) === normalized(actual, settings)
    );
  if (column.type === "date" || column.type === "datetime")
    return (
      dateValue(expected, column.type === "date") ===
      dateValue(actual, column.type === "date")
    );
  return expected === actual;
}

function compareTables(
  expected: ObjectValue,
  answer: ObjectValue,
  settings: Settings,
  format?: AnswerFormat,
): Verdict {
  const gold = readTable(expected);
  const aliases = columnAliasMap(
    gold.columns.map((column) => column.name),
    settings.columnAliases ?? {},
  );
  let actual: Table;
  try {
    const renamed = renameSubmittedColumns(answer, aliases);
    const invalid = validateEvaluationFormat(
      format,
      renamed.rows ?? null,
      settings,
    );
    if (invalid) return invalid;
    // Submitted schema cannot narrow the accepted reference structure or forbid a public null.
    actual = readTable({
      ...renamed,
      columns: Array.isArray(renamed.columns)
        ? renamed.columns.map((column) =>
            record(column)
              ? {
                  ...column,
                  nullable: true,
                  ...(settings.columnRules?.[String(column.name)]
                    ?.dateComparison
                    ? { type: "string" }
                    : {}),
                }
              : column,
          )
        : renamed.columns!,
    });
  } catch (error) {
    return verdict(
      false,
      `Invalid submitted table: ${(error as Error).message}`,
      { reason: "invalid_submission", path: "" },
    );
  }
  if (!settings.topK && gold.rows.length !== actual.rows.length)
    return verdict(
      false,
      `Expected ${gold.rows.length} rows; received ${actual.rows.length}.`,
      {
        reason: "row_count",
        path: "",
        expectedCount: gold.rows.length,
        actualCount: actual.rows.length,
      },
    );
  if (gold.columns.length !== actual.columns.length)
    return verdict(
      false,
      "The submitted column count differs from the expected table.",
      {
        reason: "column_count",
        path: "",
        expectedCount: gold.columns.length,
        actualCount: actual.columns.length,
      },
    );
  const mapping = gold.columns.map((column, index) =>
    settings.allowColumnPermutation
      ? actual.columns.findIndex((candidate) => candidate.name === column.name)
      : index,
  );
  const columnsMatch = gold.columns.every((column, index) => {
    const candidate = actual.columns[mapping[index]!];
    return (
      candidate?.name === column.name &&
      (candidate.type === column.type ||
        (!!settings.columnRules?.[column.name]?.dateComparison &&
          candidate.type === "string") ||
        (["decimal", "integer"].includes(column.type) &&
          ["decimal", "integer"].includes(candidate.type)))
    );
  });
  if (!columnsMatch)
    return verdict(
      false,
      "The submitted columns differ from the expected names, types, or order.",
      { reason: "column_schema", path: "" },
    );
  let remainingChecks = 250_000;
  const matchRow = (left: ObjectValue, right: ObjectValue) =>
    gold.columns.every((column, index) => {
      if (--remainingChecks < 0)
        throw new Error(
          "Table comparison exceeds the bounded comparison budget. Narrow the result or use more specific checks.",
        );
      return cellMatches(
        left[column.name]!,
        right[actual.columns[mapping[index]!]!.name]!,
        column,
        settings,
      );
    });
  const ordered =
    settings.tableOrder === "ordered" ||
    (settings.tableOrder !== "unordered" && expected.ordered === true);
  const keys = settings.orderBy ?? expected.order_by;
  if (settings.topK) return compareTopK(gold, actual, settings, matchRow);
  if (
    keys !== undefined &&
    (!Array.isArray(keys) ||
      !keys.length ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !gold.columns.some((column) => column.name === key),
      ) ||
      new Set(keys).size !== keys.length)
  )
    throw new Error("Ordering keys must name unique declared columns.");
  if (!ordered)
    return verdict(
      rowsMatch(gold.rows.length, (left, right) =>
        matchRow(gold.rows[left]!, actual.rows[right]!),
      ),
      "Compared the full table as an unordered collection, preserving duplicate rows.",
      {
        reason: "row_membership",
        path: "",
        expectedCount: gold.rows.length,
        actualCount: actual.rows.length,
      },
    );
  if (!keys) {
    const mismatch = gold.rows.findIndex(
      (row, index) => !matchRow(row, actual.rows[index]!),
    );
    return verdict(mismatch < 0, "Compared every row in the expected order.", {
      reason: "ordered_row_mismatch",
      path: mismatch < 0 ? "" : `/${mismatch}`,
      row: mismatch,
    });
  }
  const tieColumns = (keys as string[]).map((key) =>
    gold.columns.find((column) => column.name === key)!,
  );
  let start = 0;
  while (start < gold.rows.length) {
    let end = start + 1;
    while (
      end < gold.rows.length &&
      tieColumns.every((column) =>
        cellMatches(
          gold.rows[start]![column.name]!,
          gold.rows[end]![column.name]!,
          column,
          {
            ...settings,
            absoluteTolerance: 0,
            relativeTolerance: 0,
            decimalPlaces: undefined,
            columnRules: {},
          },
        ),
      )
    )
      end++;
    if (
      !rowsMatch(end - start, (left, right) =>
        matchRow(gold.rows[start + left]!, actual.rows[start + right]!),
      )
    )
      return verdict(
        false,
        "Values or ranking differ outside the allowed tied groups.",
        {
          reason: "rank_group_mismatch",
          path: `/${start}`,
          groupStart: start,
          groupEndExclusive: end,
        },
      );
    start = end;
  }
  return verdict(
    true,
    "Values and ranking match; rows with equal ordering keys can appear in either order.",
  );
}

function normalizeSubmittedAnswer(expected: ObjectValue, answer: Json): Json {
  if (expected.type === "table" && typeof answer === "string") {
    try {
      const parsed = JSON.parse(answer) as Json;
      if (
        Array.isArray(parsed) ||
        (parsed !== null &&
          typeof parsed === "object" &&
          !Array.isArray(parsed))
      )
        answer = parsed;
    } catch {
      /* Plain prose remains a different answer representation. */
    }
  }
  if (record(answer) && Object.hasOwn(answer, "type")) return answer;
  if (
    expected.type === "numeric" &&
    (typeof answer === "number" || typeof answer === "string")
  )
    return { type: "numeric", value: answer };
  if (expected.type === "string" && typeof answer === "string")
    return { type: "string", value: answer };
  if (expected.type === "table" && Array.isArray(answer)) {
    const column =
      Array.isArray(expected.columns) && expected.columns.length === 1
        ? expected.columns[0]
        : undefined;
    const rows =
      column &&
      record(column) &&
      typeof column.name === "string" &&
      answer.every((value) => value === null || typeof value !== "object")
        ? answer.map((value) => ({ [column.name as string]: value }))
        : answer;
    return { type: "table", columns: expected.columns!, rows };
  }
  if (expected.type === "table" && record(answer) && Array.isArray(answer.rows))
    return {
      ...answer,
      type: "table",
      columns: answer.columns ?? expected.columns!,
    };
  if (expected.type === "null_scalar" && answer === null)
    return { type: "null_scalar" };
  if (
    expected.type === "empty_table" &&
    Array.isArray(answer) &&
    !answer.length
  )
    return { type: "empty_table" };
  return answer;
}

function compareTopK(
  gold: Table,
  actual: Table,
  settings: Settings,
  matches: (left: ObjectValue, right: ObjectValue) => boolean,
): Verdict {
  const policy = settings.topK!;
  const rank = (left: ObjectValue, right: ObjectValue): number => {
    for (const key of policy.orderBy) {
      const column = gold.columns.find((item) => item.name === key.column)!;
      const a = left[key.column]!,
        b = right[key.column]!;
      if (a === null || b === null)
        throw new Error("Top-k ordering keys cannot contain null values.");
      let order: number;
      if (["integer", "decimal"].includes(column.type))
        order = compareDecimals(a, b);
      else {
        const temporalMode =
          settings.columnRules?.[column.name]?.dateComparison ??
          (column.type === "date" || column.type === "datetime"
            ? column.type
            : undefined);
        const temporalRank = (value: Json) =>
          temporalValue(value, temporalMode!)!.replace(
            /\.(\d+)Z$/,
            (_match, fraction: string) => `.${fraction.padEnd(9, "0")}Z`,
          );
        const x = temporalMode ? temporalRank(a) : String(a);
        const y = temporalMode ? temporalRank(b) : String(b);
        order = x < y ? -1 : x > y ? 1 : 0;
      }
      if (order) return key.direction === "asc" ? order : -order;
    }
    return 0;
  };
  const pool = [...gold.rows].sort(rank);
  const count = Math.min(policy.count, pool.length);
  if (actual.rows.length !== count)
    return verdict(
      false,
      `Expected ${count} ranked rows; received ${actual.rows.length}.`,
    );
  if (!count) return verdict(true, "The complete ranking pool is empty.");
  const cutoff = pool[count - 1]!;
  const eligible = pool.filter((row) => rank(row, cutoff) <= 0);
  const correct = rowsMatch(eligible.length, (left, right) =>
    right < count
      ? matches(eligible[left]!, actual.rows[right]!)
      : rank(eligible[left]!, cutoff) === 0,
  );
  if (!correct)
    return verdict(
      false,
      "The ranking omits a required row or includes a row outside the complete cutoff pool.",
    );
  if (
    actual.rows.some(
      (row, index) => index > 0 && rank(actual.rows[index - 1]!, row) > 0,
    )
  )
    return verdict(
      false,
      "Rows differ from the declared ranking outside tied groups.",
    );
  return verdict(
    true,
    "All higher-ranked rows match; cutoff ties come from the complete reference pool.",
  );
}

/** Validate private reference structure and policy before publication or comparison. */
export function validateReference(expected: Json, settings: Settings): void {
  const typed = record(expected) ? expected : undefined;
  const table = typed?.type === "table" ? readTable(typed) : undefined;
  if (table && settings.unwrapSingleton)
    throw new Error(
      "Singleton unwrapping cannot apply to a typed table; its outer array represents rows.",
    );
  if (
    typed &&
    typeof typed.type === "string" &&
    states.has(typed.type) &&
    !validState(typed)
  )
    throw new Error(
      "The expected answer state contains contradictory or unsupported fields.",
    );
  if (
    typed?.type === "numeric" &&
    typed.value_type !== undefined &&
    !["integer", "decimal"].includes(String(typed.value_type))
  )
    throw new Error("Numeric value_type must be integer or decimal.");
  if (
    (settings.topK || Object.keys(settings.columnRules ?? {}).length) &&
    (settings.mode !== "auto" || !table)
  )
    throw new Error(
      "Column rules and top-k require Auto comparison with a typed table.",
    );
  if (
    settings.decimalPlaces !== undefined &&
    !(
      settings.mode === "numeric" ||
      (settings.mode === "auto" &&
        (typeof expected === "number" || typed?.type === "numeric" || !!table))
    )
  )
    throw new Error(
      "Decimal places require numeric comparison or an Auto numeric or typed table reference.",
    );
  if (
    settings.dateComparison &&
    !(
      (settings.mode === "text" && typeof expected === "string") ||
      (settings.mode === "auto" &&
        (typeof expected === "string" || typed?.type === "string"))
    )
  )
    throw new Error(
      "A scalar date policy requires text comparison or an Auto string reference. Use column rules for tables.",
    );
  if (settings.mode === "numeric" && parseDecimal(expected) === undefined)
    throw new Error("Numeric comparison requires a valid numeric reference.");
  if (
    table &&
    typed?.ordered !== undefined &&
    typeof typed.ordered !== "boolean"
  )
    throw new Error("The table ordered declaration must be a boolean.");
  if (
    typed?.type === "numeric" &&
    (typed.value === undefined ||
      parseDecimal(typed.value) === undefined ||
      (typed.value_type === "integer" && !isIntegerDecimal(typed.value)))
  )
    throw new Error("The expected numeric value is invalid.");
  if (
    typed?.type === "string" &&
    (typeof typed.value !== "string" ||
      (typed.aliases !== undefined &&
        (!Array.isArray(typed.aliases) ||
          typed.aliases.some((value) => typeof value !== "string"))))
  )
    throw new Error("The expected string value or aliases are invalid.");
  const keys = settings.orderBy ?? typed?.order_by;
  if (
    keys !== undefined &&
    (!table ||
      !Array.isArray(keys) ||
      !keys.length ||
      new Set(keys).size !== keys.length ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !table.columns.some((column) => column.name === key),
      ))
  )
    throw new Error("Ordering keys must name unique declared columns.");
  if (table) {
    columnAliasMap(
      table.columns.map((column) => column.name),
      settings.columnAliases ?? {},
    );
    for (const [name, rule] of Object.entries(settings.columnRules ?? {})) {
      const column = table.columns.find((item) => item.name === name);
      if (!column)
        throw new Error(
          `Column rule ${name} is not a declared expected column.`,
        );
      if (
        (rule.decimalPlaces !== undefined ||
          rule.absoluteTolerance !== undefined ||
          rule.relativeTolerance !== undefined) &&
        !["decimal", "integer"].includes(column.type)
      )
        throw new Error(`Numeric rules require a numeric column: ${name}.`);
      if (
        rule.dateComparison &&
        (!["date", "datetime", "string"].includes(column.type) ||
          table.rows.some(
            (row) =>
              row[name] !== null &&
              temporalValue(row[name]!, rule.dateComparison!) === undefined,
          ))
      )
        throw new Error(
          `Temporal rules require valid reference dates: ${name}.`,
        );
    }
  } else if (
    Object.keys(settings.columnRules ?? {}).length ||
    Object.keys(settings.columnAliases ?? {}).length ||
    settings.topK
  )
    throw new Error(
      "Column and top-k policies require a typed table reference.",
    );
  if (settings.dateComparison) {
    const value = typed?.type === "string" ? typed.value! : expected;
    if (!table && temporalValue(value, settings.dateComparison) === undefined)
      throw new Error("The temporal reference is invalid.");
  }
  if (settings.topK && table) {
    const keys = settings.topK.orderBy;
    if (
      !settings.topK.referenceComplete ||
      !keys.length ||
      new Set(keys.map((key) => key.column)).size !== keys.length
    )
      throw new Error(
        "Top-k requires a complete pool and unique ordering columns.",
      );
    for (const key of keys)
      if (
        !table.columns.some((column) => column.name === key.column) ||
        table.rows.some((row) => row[key.column] === null)
      )
        throw new Error(
          "Top-k ordering keys must name declared, non-null columns.",
        );
  }
}

function validState(value: ObjectValue): boolean {
  const allowed = new Set(["type", "reason", "explanation"]);
  if (value.type === "empty_table") allowed.add("rows");
  if (value.type === "null_scalar") allowed.add("value");
  return (
    Object.keys(value).every((key) => allowed.has(key)) &&
    (value.reason === undefined || typeof value.reason === "string") &&
    (value.explanation === undefined ||
      typeof value.explanation === "string") &&
    (value.type !== "empty_table" ||
      value.rows === undefined ||
      (Array.isArray(value.rows) && value.rows.length === 0)) &&
    (value.type !== "null_scalar" ||
      value.value === undefined ||
      value.value === null)
  );
}

/** Return null for generic JSON; explicit typed states keep their semantic meaning. */
export function gradeTypedAnswer(
  expected: Json,
  answer: Json,
  settings: EvaluatorSettings,
  format?: AnswerFormat,
): Verdict | null {
  if (
    !record(expected) ||
    typeof expected.type !== "string" ||
    !["string", "numeric", "table", ...states].includes(expected.type)
  )
    return null;
  try {
    validateReference(expected, settings);
    if (expected.type === "table") readTable(expected);
    if (
      expected.type === "numeric" &&
      (expected.value === undefined ||
        parseDecimal(expected.value) === undefined)
    )
      throw new Error("The expected numeric value is invalid.");
    if (expected.type === "string" && typeof expected.value !== "string")
      throw new Error("The expected string value is invalid.");
    answer = normalizeSubmittedAnswer(expected, answer);
    if (!record(answer) || answer.type !== expected.type)
      return verdict(
        false,
        `Expected answer type ${expected.type}; received a different answer state.`,
      );
    if (expected.type !== "table") {
      const invalid = validateEvaluationFormat(
        format,
        referenceAnswerValue(answer),
        settings,
      );
      if (invalid) return invalid;
    }
    if (states.has(expected.type))
      return validState(answer)
        ? verdict(true, `The ${expected.type} state matches.`)
        : verdict(
            false,
            "The submitted answer state contains contradictory or unsupported fields.",
            { reason: "invalid_answer_state", path: "" },
          );
    if (expected.type === "numeric") {
      if (
        expected.value_type === "integer" &&
        !isIntegerDecimal(expected.value!)
      )
        throw new Error(
          "Expected integers must be exact integer values; use decimal strings for large integers.",
        );
      const correct =
        answer.value !== undefined &&
        (expected.value_type !== "integer" || isIntegerDecimal(answer.value)) &&
        (settings.decimalPlaces !== undefined
          ? roundedDecimalsMatch(
              expected.value!,
              answer.value,
              settings.decimalPlaces,
            )
          : decimalsMatch(
              expected.value!,
              answer.value,
              settings.absoluteTolerance,
              settings.relativeTolerance,
            ));
      return verdict(
        correct,
        correct
          ? "The numeric value matches the frozen decimal tolerances."
          : "The numeric value differs beyond the frozen tolerances or is invalid.",
      );
    }
    if (expected.type === "string") {
      if (
        expected.aliases !== undefined &&
        (!Array.isArray(expected.aliases) ||
          expected.aliases.some((alias) => typeof alias !== "string"))
      )
        throw new Error("String aliases must be strings.");
      const aliases = [
        expected.value as string,
        ...((expected.aliases ?? []) as string[]),
      ];
      const submitted = answer.value;
      const correct =
        typeof submitted === "string" &&
        aliases.some((alias) =>
          settings.dateComparison
            ? temporalValue(alias, settings.dateComparison) !== undefined &&
              temporalValue(alias, settings.dateComparison) ===
                temporalValue(submitted, settings.dateComparison)
            : normalized(alias, settings) === normalized(submitted, settings),
        );
      return verdict(
        correct,
        correct
          ? "The normalized answer matches an accepted value."
          : "The answer does not match the expected value or its aliases.",
      );
    }
    return compareTables(expected, answer, settings, format);
  } catch (error) {
    return {
      status: "error",
      explanation:
        error instanceof Error ? error.message : "Typed evaluation failed.",
    };
  }
}
