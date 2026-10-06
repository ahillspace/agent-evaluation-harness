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
          label="Answer representation"
          help="Compatible accepts supported equivalent representations, including JSON-encoded tables and one-cell scalar results. Strict enforces the published public shape."
        >
          <select
            aria-label="Answer representation"
            value={settings.representationPolicy}
            onChange={(event) =>
              onChange({
                ...settings,
                representationPolicy: event.target
                  .value as EvaluatorSettings["representationPolicy"],
              })
            }
          >
            <option value="compatible">
              Compatible representations (default)
            </option>
            <option value="strict">Strict public format</option>
          </select>
        </Field>
        <Field
          label="Duplicate rows"
          help="Preserve counts every repeated row. Distinct compares unique rows and is appropriate only when the question requires a distinct result grain."
        >
          <select
            aria-label="Duplicate rows"
            value={settings.duplicateRows}
            onChange={(event) =>
              onChange({
                ...settings,
                duplicateRows: event.target
                  .value as EvaluatorSettings["duplicateRows"],
              })
            }
          >
            <option value="preserve">Preserve multiplicity (default)</option>
            <option value="distinct">Distinct rows</option>
          </select>
        </Field>
      </div>
      <Field
        label="Collation"
        help="Collation controls ordering only. It does not erase punctuation or change which cell values count as correct."
      >
        <select
          aria-label="Collation"
          value={settings.collation ? "locale" : "codepoint"}
          onChange={(event) =>
            onChange({
              ...settings,
              collation:
                event.target.value === "locale"
                  ? {
                      locale: "en-US",
                      numeric: false,
                      ignorePunctuation: false,
                      sensitivity: "variant",
                    }
                  : undefined,
            })
          }
        >
          <option value="codepoint">Unicode character order</option>
          <option value="locale">Explicit language collation</option>
        </select>
      </Field>
      {settings.collation && (
        <div className="stack">
          <div className="form-grid">
            <Field label="Collation locale">
              <input
                aria-label="Collation locale"
                value={settings.collation.locale}
                onChange={(event) =>
                  onChange({
                    ...settings,
                    collation: {
                      ...settings.collation!,
                      locale: event.target.value,
                    },
                  })
                }
              />
            </Field>
            <Field label="Collation sensitivity">
              <select
                aria-label="Collation sensitivity"
                value={settings.collation.sensitivity}
                onChange={(event) =>
                  onChange({
                    ...settings,
                    collation: {
                      ...settings.collation!,
                      sensitivity: event.target.value as NonNullable<
                        EvaluatorSettings["collation"]
                      >["sensitivity"],
                    },
                  })
                }
              >
                {["variant", "base", "accent", "case"].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </Field>
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.collation.numeric}
              onChange={(event) =>
                onChange({
                  ...settings,
                  collation: {
                    ...settings.collation!,
                    numeric: event.target.checked,
                  },
                })
              }
            />
            <span>Sort embedded numbers numerically (2 before 10)</span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.collation.ignorePunctuation}
              onChange={(event) =>
                onChange({
                  ...settings,
                  collation: {
                    ...settings.collation!,
                    ignorePunctuation: event.target.checked,
                  },
                })
              }
            />
            <span>Ignore punctuation when sorting</span>
          </label>
        </div>
      )}
      <div className="stack">
        <div className="row">
          <h4>Explicit sort order</h4>
          <button
            className="text-button"
            onClick={() =>
              onChange({
                ...settings,
                tableOrder: "ordered",
                sortOrder: [
                  ...(settings.sortOrder ?? []),
                  { column: "", direction: "asc" },
                ],
              })
            }
          >
            Add sort column
          </button>
        </div>
        <p className="subtle">
          Optional. Compare all row values, then validate this ordering
          independently of the reference row sequence. Empty uses the table
          ordering setting.
        </p>
        {settings.sortOrder?.map((key, index) => (
          <div className="form-grid" key={index}>
            <Field label={`Sort column ${index + 1}`}>
              <input
                aria-label={`Sort column ${index + 1}`}
                value={key.column}
                onChange={(event) =>
                  onChange({
                    ...settings,
                    sortOrder: settings.sortOrder!.map((item, position) =>
                      position === index
                        ? { ...item, column: event.target.value }
                        : item,
                    ),
                  })
                }
              />
            </Field>
            <Field label={`Sort direction ${index + 1}`}>
              <select
                aria-label={`Sort direction ${index + 1}`}
                value={key.direction}
                onChange={(event) =>
                  onChange({
                    ...settings,
                    sortOrder: settings.sortOrder!.map((item, position) =>
                      position === index
                        ? {
                            ...item,
                            direction: event.target.value as "asc" | "desc",
                          }
                        : item,
                    ),
                  })
                }
              >
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
            </Field>
            <button
              className="text-button"
              onClick={() => {
                const next = settings.sortOrder!.filter(
                  (_, position) => index !== position,
                );
                onChange({
                  ...settings,
                  sortOrder: next.length ? next : undefined,
                });
              }}
            >
              Remove sort column {index + 1}
            </button>
          </div>
        ))}
      </div>
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
