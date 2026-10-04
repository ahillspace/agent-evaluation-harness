import type { EvaluatorSettings } from "../contracts.js";
import { Field } from "./ui.js";

export function EvaluatorPolicy({
  settings,
  onChange,
}: {
  settings: EvaluatorSettings;
  onChange: (settings: EvaluatorSettings) => void;
}) {
  return (
    <div className="stack">
      <div className="form-grid">
        <Field
          label="Decimal places"
          help="Compare numeric values after rounding to this precision. Leave blank to use tolerances. Column rules can set different precision for currency and counts."
        >
          <input
            aria-label="Decimal places"
            type="number"
            min="0"
            max="12"
            value={settings.decimalPlaces ?? ""}
            onChange={(event) =>
              onChange({
                ...settings,
                decimalPlaces:
                  event.target.value === ""
                    ? undefined
                    : Number(event.target.value),
              })
            }
          />
        </Field>
        <Field
          label="Date comparison"
          help="Calendar date compares the stated date. Instant compares timezone-qualified timestamps as moments in time. Choose only the meaning required by the question."
        >
          <select
            aria-label="Date comparison"
            value={settings.dateComparison ?? ""}
            onChange={(event) =>
              onChange({
                ...settings,
                dateComparison: (event.target.value ||
                  undefined) as EvaluatorSettings["dateComparison"],
              })
            }
          >
            <option value="">Use declared answer type</option>
            <option value="calendar_date">Calendar date</option>
            <option value="instant">Instant in time</option>
          </select>
        </Field>
      </div>
      <Field
        label="Answer extraction path"
        help="An explicit JSON Pointer into the submitted answer, such as /data/rows. Escape / as ~1 and ~ as ~0 in field names. Blank compares the complete answer; no automatic search occurs."
      >
        <input
          aria-label="Answer extraction path"
          placeholder="/data/rows"
          value={settings.answerPath ?? ""}
          onChange={(event) =>
            onChange({
              ...settings,
              answerPath: event.target.value || undefined,
            })
          }
        />
      </Field>
      <label className="check-row">
        <input
          type="checkbox"
          checked={settings.unwrapSingleton ?? false}
          onChange={(event) =>
            onChange({ ...settings, unwrapSingleton: event.target.checked })
          }
        />
        <span>
          Accept a single-item list as a scalar
          <small>
            Requires exactly one item. Empty and multi-item lists remain
            distinct.
          </small>
        </span>
      </label>
      <Field
        label="Reference status"
        help="Use Needs review when the reference cannot support a reliable verdict. These answers remain visible but are excluded from scored accuracy. A disagreement alone does not prove the reference is wrong."
      >
        <select
          aria-label="Reference status"
          value={settings.referenceDisposition ?? "usable"}
          onChange={(event) =>
            onChange({
              ...settings,
              referenceDisposition: event.target
                .value as EvaluatorSettings["referenceDisposition"],
            })
          }
        >
          <option value="usable">Usable for scoring</option>
          <option value="needs_review">
            Needs review - exclude from accuracy
          </option>
        </select>
      </Field>
      {settings.referenceDisposition === "needs_review" && (
        <Field label="Reference review reason" required>
          <textarea
            aria-label="Reference review reason"
            rows={3}
            value={settings.referenceNote ?? ""}
            onChange={(event) =>
              onChange({ ...settings, referenceNote: event.target.value })
            }
          />
        </Field>
      )}
      <p className="subtle">
        These are bank defaults. Use question overrides for rules that apply to
        selected questions only.
      </p>
    </div>
  );
}
