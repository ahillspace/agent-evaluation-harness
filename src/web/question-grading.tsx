import { useState } from "react";
import {
  evaluatorSettingsSchema,
  type EvaluatorSettings,
} from "../contracts.js";
import { EvaluatorPolicy } from "./evaluator-policy.js";
import { ErrorNotice, Field, Modal } from "./ui.js";

type Override = EvaluatorSettings["questionOverrides"][string];
type GradingProps = {
  settings: EvaluatorSettings;
  onSettings: (settings: EvaluatorSettings) => void;
};

function effectiveRuleSummary(settings: EvaluatorSettings): string {
  const numeric =
    settings.decimalPlaces === undefined
      ? `Numeric tolerance: absolute ${settings.absoluteTolerance}, relative ${settings.relativeTolerance}.`
      : `Round numeric values to ${settings.decimalPlaces} decimal places.`;
  const text = settings.dateComparison
    ? settings.dateComparison === "calendar_date"
      ? "Compare calendar dates."
      : "Compare timestamps as instants in time."
    : `${settings.caseSensitive ? "Match" : "Ignore"} text capitalization. ${settings.trimWhitespace ? "Trim" : "Preserve"} outer whitespace. ${settings.collapseWhitespace ? "Normalize" : "Preserve"} repeated whitespace.`;
  const list = settings.arrayOrderMatters
    ? "Require list order."
    : "Ignore list order.";
  if (settings.mode === "custom")
    return "The custom function determines the verdict.";
  if (settings.mode === "exact")
    return "Require identical values and list order.";
  if (settings.mode === "numeric") return numeric;
  if (settings.mode === "text") return text;
  if (settings.mode === "json")
    return `Numeric tolerance: absolute ${settings.absoluteTolerance}, relative ${settings.relativeTolerance}. ${list}`;
  const table = {
    expected: "Follow declared reference ordering.",
    ordered: "Require ordered table rows.",
    unordered: "Ignore table row order.",
  }[settings.tableOrder];
  return `${numeric} ${text} ${list} ${table}`;
}

export function AppliedRulesJson({
  label,
  value,
  onApply,
  help,
}: {
  label: string;
  value: unknown;
  onApply: (value: unknown) => void;
  help: string;
}) {
  const current = value === undefined ? "" : JSON.stringify(value, null, 2);
  const [editing, setEditing] = useState<{
    label: string;
    original: string;
    text: string;
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const changedBasis =
    !!editing && (editing.original !== current || editing.label !== label);
  const start = () => {
    setEditing({ label, original: current, text: current });
    setError(null);
  };
  return (
    <div className="stack">
      <Field label={label} help={help}>
        <pre aria-label={`${label} current JSON`} className="json-view">
          {current || "Not configured"}
        </pre>
      </Field>
      <button type="button" className="button secondary" onClick={start}>
        Edit {label.toLowerCase()}
      </button>
      {editing && (
        <Modal
          title={`Edit ${editing.label.toLowerCase()}`}
          onClose={() => setEditing(null)}
        >
          <div className="stack">
            <p className="subtle">{help}</p>
            <p className="subtle">
              Edits join the bank draft only when you apply them. Closing this
              dialog discards unapplied edits.
            </p>
            <Field label={`${editing.label} JSON`}>
              <textarea
                aria-label={`${editing.label} JSON`}
                className="code-input"
                rows={10}
                value={editing.text}
                onChange={(event) => {
                  setEditing({ ...editing, text: event.target.value });
                  setError(null);
                }}
              />
            </Field>
            {changedBasis && (
              <div className="notice" role="alert">
                <p>
                  The current rules changed while this editor was open. Copy
                  your edits before loading the current JSON.
                </p>
                <button className="button secondary" onClick={start}>
                  Load current JSON
                </button>
              </div>
            )}
            <ErrorNotice error={error} />
            <footer className="modal-footer">
              <button
                type="button"
                className="button secondary"
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button primary"
                disabled={changedBasis || editing.text === editing.original}
                onClick={() => {
                  try {
                    onApply(
                      editing.text.trim()
                        ? (JSON.parse(editing.text) as unknown)
                        : undefined,
                    );
                    setEditing(null);
                    setError(null);
                  } catch (cause) {
                    setError(cause);
                  }
                }}
              >
                Apply {editing.label.toLowerCase()}
              </button>
            </footer>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ComparisonFields({
  settings,
  onRule,
  override,
  onInherit,
}: {
  settings: EvaluatorSettings;
  onRule: <K extends keyof Override>(key: K, value: Override[K]) => void;
  override?: Override;
  onInherit?: (key: keyof Override) => void;
}) {
  const reset = (key: keyof Override) =>
    onInherit && Object.hasOwn(override ?? {}, key) ? (
      <button
        type="button"
        className="text-button"
        onClick={() => onInherit(key)}
      >
        Use bank{" "}
        {(
          {
            mode: "comparison mode",
            decimalPlaces: "precision",
            absoluteTolerance: "absolute tolerance",
            relativeTolerance: "relative tolerance",
            caseSensitive: "capitalization rule",
            trimWhitespace: "outer whitespace rule",
            collapseWhitespace: "repeated whitespace rule",
            arrayOrderMatters: "list ordering",
            allowColumnPermutation: "column ordering",
            tableOrder: "table ordering",
            orderBy: "ordering keys",
          } as Partial<Record<keyof Override, string>>
        )[key] ?? "rule"}
      </button>
    ) : null;
  return (
    <div className="stack">
      <Field
        label="Comparison mode"
        help="Automatic selects comparison from the reference value. A custom function runs in an isolated evaluator."
      >
        <select
          aria-label="Comparison mode"
          value={settings.mode}
          onChange={(event) =>
            onRule("mode", event.target.value as EvaluatorSettings["mode"])
          }
        >
          {Object.entries({
            auto: "Automatic",
            exact: "Exact value",
            text: "Text",
            numeric: "Number",
            json: "Structured data",
            custom: "Custom function",
          }).map(([mode, label]) => (
            <option key={mode} value={mode}>
              {label}
            </option>
          ))}
        </select>
        {reset("mode")}
      </Field>
      <div className="form-grid">
        <Field
          label="Decimal places"
          help={
            onInherit
              ? "Round both numeric values to this precision. Blank inherits the bank precision. This does not require a display format."
              : "Round both numeric values to this precision. Blank uses numeric tolerances. This does not require a display format."
          }
        >
          <input
            aria-label="Decimal places"
            type="number"
            min="0"
            max="12"
            step="1"
            value={settings.decimalPlaces ?? ""}
            onChange={(event) =>
              onRule(
                "decimalPlaces",
                event.target.value === ""
                  ? undefined
                  : Number(event.target.value),
              )
            }
          />
          {reset("decimalPlaces")}
        </Field>
        <Field
          label="Absolute tolerance"
          help="Maximum absolute numeric difference when decimal precision is unset."
        >
          <input
            aria-label="Absolute tolerance"
            type="number"
            min="0"
            step="any"
            value={settings.absoluteTolerance}
            onChange={(event) =>
              onRule("absoluteTolerance", Number(event.target.value))
            }
          />
          {reset("absoluteTolerance")}
        </Field>
        <Field
          label="Relative tolerance"
          help="Maximum numeric difference as a fraction of the reference value when decimal precision is unset."
        >
          <input
            aria-label="Relative tolerance"
            type="number"
            min="0"
            step="any"
            value={settings.relativeTolerance}
            onChange={(event) =>
              onRule("relativeTolerance", Number(event.target.value))
            }
          />
          {reset("relativeTolerance")}
        </Field>
      </div>
      <div className="check-grid">
        {(
          [
            "caseSensitive",
            "trimWhitespace",
            "collapseWhitespace",
            "arrayOrderMatters",
            "allowColumnPermutation",
          ] as const
        ).map((key) => (
          <div key={key}>
            <label className="check-row">
              <input
                type="checkbox"
                checked={settings[key]}
                onChange={(event) => onRule(key, event.target.checked)}
              />
              {
                {
                  caseSensitive: "Match text capitalization",
                  trimWhitespace: "Trim outer whitespace",
                  collapseWhitespace: "Normalize repeated whitespace",
                  arrayOrderMatters: "Require list order",
                  allowColumnPermutation:
                    "Allow table columns in a different order",
                }[key]
              }
            </label>
            {reset(key)}
          </div>
        ))}
      </div>
      <div className="form-grid">
        <Field
          label="Table ordering"
          help="Expected follows declared reference ordering. Ordered checks row positions and declared ties. Unordered compares all rows without positions."
        >
          <select
            aria-label="Table ordering"
            value={settings.tableOrder}
            onChange={(event) =>
              onRule(
                "tableOrder",
                event.target.value as EvaluatorSettings["tableOrder"],
              )
            }
          >
            <option value="expected">Use declared reference ordering</option>
            <option value="ordered">Require ordered rows</option>
            <option value="unordered">Compare unordered rows</option>
          </select>
          {reset("tableOrder")}
        </Field>
        <Field
          label="Ordering keys"
          help="Canonical column names separated by commas. Equal key values can appear in either order."
        >
          <input
            aria-label="Ordering keys"
            value={settings.orderBy?.join(", ") ?? ""}
            onChange={(event) =>
              onRule(
                "orderBy",
                event.target.value.trim()
                  ? event.target.value
                      .split(",")
                      .map((item) => item.trim())
                      .filter(Boolean)
                  : undefined,
              )
            }
          />
          {reset("orderBy")}
        </Field>
      </div>
    </div>
  );
}

function CodeFields({ settings, onSettings }: GradingProps) {
  return (
    <div className="stack">
      <Field
        label="Required evidence"
        help="Answer evidence supports external endpoints. Declare internal activity only for grading that requires recorded agent steps."
      >
        <select
          aria-label="Evaluator required evidence"
          value={
            settings.evidenceRequirement ??
            (settings.mode === "custom" ? "unspecified" : "answer")
          }
          onChange={(event) =>
            onSettings({
              ...settings,
              evidenceRequirement: event.target
                .value as EvaluatorSettings["evidenceRequirement"],
            })
          }
        >
          <option value="answer">Answer evidence</option>
          <option value="internal-activity">Internal agent activity</option>
          <option value="unspecified">Not declared</option>
        </select>
      </Field>
      <Field
        label="Custom evaluator code"
        help="Code receives input.expected and input.answer only. Return {verdict: boolean, explanation?: string, details?: JSON}. The isolated interpreter has no filesystem or network access, a 100 ms time limit, and a 16 MB memory limit. Select Custom function to activate code."
      >
        <textarea
          aria-label="Custom evaluator code"
          className="code-input"
          rows={8}
          value={settings.code ?? ""}
          onChange={(event) =>
            onSettings({ ...settings, code: event.target.value })
          }
          placeholder="return {verdict: input.answer === input.expected, explanation: 'Exact match'};"
        />
      </Field>
    </div>
  );
}

function AdvancedFields({ settings, onSettings }: GradingProps) {
  const apply = (
    key: "columnRules" | "columnAliases" | "topK",
    value: unknown,
  ) => onSettings(evaluatorSettingsSchema.parse({ ...settings, [key]: value }));
  return (
    <div className="stack">
      <EvaluatorPolicy
        settings={settings}
        onChange={onSettings}
        showDecimalPlaces={false}
      />
      <AppliedRulesJson
        label="Column comparison rules"
        value={settings.columnRules}
        onApply={(value) => apply("columnRules", value)}
        help={
          'JSON keyed by canonical column name, for example {"amount":{"decimalPlaces":2},"created":{"dateComparison":"calendar_date"}}. Apply validates these rules.'
        }
      />
      <AppliedRulesJson
        label="Column aliases"
        value={settings.columnAliases}
        onApply={(value) => apply("columnAliases", value ?? {})}
        help={
          'JSON maps canonical names to accepted submitted names, for example {"amount":["total"]}. Aliases preserve values, rows, and ordering checks.'
        }
      />
      <AppliedRulesJson
        label="Top-k ranking policy"
        value={settings.topK}
        onApply={(value) => apply("topK", value)}
        help={
          'Optional JSON: {"count":10,"orderBy":[{"column":"total","direction":"desc"}],"referenceComplete":true}. The reference must contain the complete candidate pool, including boundary ties.'
        }
      />
      <CodeFields settings={settings} onSettings={onSettings} />
    </div>
  );
}

export function SharedGradingFields({ settings, onSettings }: GradingProps) {
  return (
    <div className="stack">
      <ComparisonFields
        settings={settings}
        onRule={(key, value) => onSettings({ ...settings, [key]: value })}
      />
      <details className="disclosure">
        <summary>Advanced comparison policies and evaluator code</summary>
        <AdvancedFields settings={settings} onSettings={onSettings} />
      </details>
    </div>
  );
}

export function QuestionGradingFields({
  questionId,
  settings,
  onSettings,
}: GradingProps & { questionId: string }) {
  const override = settings.questionOverrides[questionId] ?? {};
  const effective = { ...settings, ...override };
  const update = (next: Override) => {
    const overrides = { ...settings.questionOverrides };
    if (Object.keys(next).length) overrides[questionId] = next;
    else delete overrides[questionId];
    onSettings({ ...settings, questionOverrides: overrides });
  };
  const rule = <K extends keyof Override>(key: K, value: Override[K]) => {
    const next = { ...override };
    if (value === undefined) delete next[key];
    else next[key] = value;
    update(next);
  };
  const fromEffective = (next: EvaluatorSettings) => {
    const changes = { ...override };
    for (const key of Object.keys(next) as Array<keyof Override>) {
      if (
        key === ("questionOverrides" as string) ||
        key === ("calibrationExamples" as string)
      )
        continue;
      if (JSON.stringify(next[key]) === JSON.stringify(effective[key]))
        continue;
      Object.assign(changes, { [key]: next[key] });
      if (next[key] === undefined) delete changes[key];
    }
    update(changes);
  };
  const custom = Object.keys(override).length > 0;
  return (
    <section className="stack question-grading">
      <div className="row spread">
        <h3>How this question is graded</h3>
        <span className="badge">
          {custom ? "Question-specific rules" : "Inherits bank defaults"}
        </span>
        {custom && (
          <button
            type="button"
            className="text-button"
            onClick={() => update({})}
          >
            Use bank defaults
          </button>
        )}
      </div>
      <div className="notice">
        <div>
          <strong>Effective rules</strong>
          <p>
            {effectiveRuleSummary(effective)}{" "}
            {effective.referenceDisposition === "needs_review"
              ? `Excluded from accuracy: ${effective.referenceNote ?? "Review reason required."}`
              : "Reference is usable for scoring."}
          </p>
        </div>
      </div>
      <details className="disclosure">
        <summary>Customize grading rules</summary>
        <div className="stack">
          <p className="subtle">
            Editing a rule overrides that field for this question. Other fields
            inherit the current bank defaults.
          </p>
          <ComparisonFields
            settings={effective}
            override={override}
            onRule={rule}
            onInherit={(key) => rule(key, undefined)}
          />
          <details className="disclosure">
            <summary>Advanced question policies and evaluator code</summary>
            <div className="stack">
              <AdvancedFields settings={effective} onSettings={fromEffective} />
              <AppliedRulesJson
                label="Question rules"
                value={override}
                onApply={(value) => {
                  const parsed = evaluatorSettingsSchema.parse({
                    ...settings,
                    questionOverrides: {
                      ...settings.questionOverrides,
                      [questionId]: value ?? {},
                    },
                  });
                  update(parsed.questionOverrides[questionId] ?? {});
                }}
                help="JSON contains only this question's overrides. Omitted fields inherit bank defaults. Apply replaces these overrides after validation; use this to remove individual advanced overrides."
              />
            </div>
          </details>
        </div>
      </details>
    </section>
  );
}
