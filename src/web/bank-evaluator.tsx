import { useState } from "react";
import {
  evaluatorSettingsSchema,
  type BankDetail,
  type EvaluatorDraft,
  type EvaluatorSettings,
  type EvaluationPreview,
  type CalibrationReport,
  type WorkspaceView,
} from "../contracts.js";
import { command } from "./api.js";
import { EvaluatorPreview } from "./evaluator-preview.js";
import { EvaluatorPolicy } from "./evaluator-policy.js";
import { CalibrationResults } from "./calibration-results.js";
import {
  ReferenceSelector,
  ReferencePolicyWarning,
} from "./reference-selector.js";
import { ErrorNotice, Field, Help, Icon, date } from "./ui.js";

export function BankEvaluator({
  workspace,
  bankId,
  refresh,
}: {
  workspace: WorkspaceView &
    Pick<BankDetail, "evaluatorRevisions" | "evaluatorDrafts" | "revisions">;
  bankId: string;
  refresh: () => void;
}) {
  const bank = workspace.banks.find((item) => item.id === bankId)!;
  const revisions = workspace.evaluatorRevisions.filter(
    (item) => item.bankId === bankId,
  );
  const active = revisions.find(
    (item) => item.id === bank.activeEvaluatorRevisionId,
  );
  const existingDraft = workspace.evaluatorDrafts.find(
    (item) => item.bankId === bankId,
  );
  const [name, setName] = useState(existingDraft?.name ?? "Updated evaluator");
  const [settings, setSettings] = useState<EvaluatorSettings>(
    existingDraft?.settings ??
      active?.settings ??
      evaluatorSettingsSchema.parse({}),
  );
  const [draft, setDraft] = useState<EvaluatorDraft | null>(
    existingDraft ?? null,
  );
  const [overrides, setOverrides] = useState(
    JSON.stringify(settings.questionOverrides ?? {}, null, 2),
  );
  const [preview, setPreview] = useState<EvaluationPreview | null>(null);
  const [calibration, setCalibration] = useState<CalibrationReport | null>(
    null,
  );
  const [referenceId, setReferenceId] = useState("");
  const [columnRules, setColumnRules] = useState(
    JSON.stringify(settings.columnRules ?? {}, null, 2),
  );
  const [topK, setTopK] = useState(
    settings.topK ? JSON.stringify(settings.topK, null, 2) : "",
  );
  const [cases, setCases] = useState(
    JSON.stringify(settings.calibrationExamples ?? [], null, 2),
  );
  const [runIds, setRunIds] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState("");
  const mutate = async (action: string) => {
    setPending(action);
    setError(null);
    setPreview(null);
    setCalibration(null);
    try {
      const saved = await command("evaluators.draft", {
        bankId,
        draftId: draft?.id,
        name,
        settings: evaluatorSettingsSchema.parse({
          ...settings,
          questionOverrides: JSON.parse(overrides),
          columnRules: JSON.parse(columnRules),
          topK: topK.trim() ? JSON.parse(topK) : undefined,
          calibrationExamples: JSON.parse(cases),
        }),
      });
      setDraft(saved);
      if (action === "preview")
        setPreview(
          await command("evaluators.preview", {
            draftId: saved.id,
            runIds,
            bankRevisionId: referenceId || undefined,
          }),
        );
      if (action === "calibrate")
        setCalibration(
          await command("evaluators.calibrate", {
            draftId: saved.id,
            bankRevisionId: referenceId || undefined,
          }),
        );
      if (action === "publish") {
        await command("evaluators.publish", {
          draftId: saved.id,
          activate: true,
        });
        setDraft(null);
        setPreview(null);
      }
      refresh();
    } catch (cause) {
      setError(cause);
    } finally {
      setPending("");
    }
  };
  return (
    <div className="panel-body stack">
      <div className="section-intro">
        <Icon name="shield" />
        <div>
          <h3>Deterministic grading</h3>
          <p>
            Each run freezes its evaluator. Optional judge assessments and human
            reviews remain separate.
          </p>
        </div>
      </div>
      <ErrorNotice error={error} />
      <div className="notice">
        Active: <strong>{active?.name ?? "Default evaluator"}</strong>
        {active ? ` · revision ${active.number}` : ""}
      </div>
      <ReferencePolicyWarning
        questions={
          workspace.revisions.find(
            (revision) =>
              revision.id === (referenceId || bank.latestRevisionId),
          )?.questions ?? []
        }
      />
      <div className="form-grid">
        <Field label="Revision name">
          <input
            aria-label="Evaluator revision name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field
          label="Comparison mode"
          help="Auto chooses numeric, text, or JSON comparison from the expected value. Custom code runs in an isolated evaluator."
        >
          <select
            aria-label="Comparison mode"
            value={settings.mode}
            onChange={(event) =>
              setSettings({
                ...settings,
                mode: event.target.value as EvaluatorSettings["mode"],
              })
            }
          >
            {["auto", "exact", "text", "numeric", "json", "custom"].map(
              (mode) => (
                <option key={mode}>{mode}</option>
              ),
            )}
          </select>
        </Field>
      </div>
      <div className="form-grid">
        <Field label="Absolute tolerance">
          <input
            aria-label="Absolute tolerance"
            type="number"
            min="0"
            step="any"
            value={settings.absoluteTolerance}
            onChange={(event) =>
              setSettings({
                ...settings,
                absoluteTolerance: Number(event.target.value),
              })
            }
          />
        </Field>
        <Field label="Relative tolerance">
          <input
            aria-label="Relative tolerance"
            type="number"
            min="0"
            step="any"
            value={settings.relativeTolerance}
            onChange={(event) =>
              setSettings({
                ...settings,
                relativeTolerance: Number(event.target.value),
              })
            }
          />
        </Field>
      </div>
      <div className="check-grid">
        {(
          [
            "caseSensitive",
            "trimWhitespace",
            "collapseWhitespace",
            "arrayOrderMatters",
          ] as const
        ).map((key) => (
          <label key={key} className="check-row">
            <input
              type="checkbox"
              checked={settings[key]}
              onChange={(event) =>
                setSettings({ ...settings, [key]: event.target.checked })
              }
            />
            {
              {
                caseSensitive: "Case sensitive",
                trimWhitespace: "Trim outer whitespace",
                collapseWhitespace: "Normalize whitespace",
                arrayOrderMatters: "Preserve array order",
              }[key]
            }
          </label>
        ))}
      </div>
      <Field
        label="Required evidence"
        help="Answer evidence works with external endpoints. Internal activity requires recorded agent steps. Custom evaluation must declare its requirement before an external run."
      >
        <select
          aria-label="Evaluator required evidence"
          value={
            settings.evidenceRequirement ??
            (settings.mode === "custom" ? "unspecified" : "answer")
          }
          onChange={(event) =>
            setSettings({
              ...settings,
              evidenceRequirement: event.target.value as
                "answer" | "internal-activity" | "unspecified",
            })
          }
        >
          <option value="answer">Answer evidence</option>
          <option value="internal-activity">Internal agent activity</option>
          <option value="unspecified">Not declared</option>
        </select>
      </Field>
      {settings.mode === "custom" && (
        <Field
          label="Custom evaluator code"
          help="Code receives input.expected and input.answer. Return {verdict: boolean, explanation?: string, details?: JSON}. The isolated interpreter has no filesystem or network access, with a 100 ms time limit and 16 MB memory limit."
        >
          <textarea
            aria-label="Custom evaluator code"
            className="code-input"
            rows={9}
            value={settings.code ?? ""}
            onChange={(event) =>
              setSettings({ ...settings, code: event.target.value })
            }
            placeholder={
              "return {verdict: input.answer === input.expected, explanation: 'Exact match'};"
            }
          />
        </Field>
      )}
      <details className="disclosure">
        <summary>Advanced table and question rules</summary>
        <div className="stack">
          <EvaluatorPolicy settings={settings} onChange={setSettings} />
          <Field
            label="Column comparison rules"
            help='JSON keyed by canonical column name. For example: {"amount":{"decimalPlaces":2},"created":{"dateComparison":"calendar_date"}}. Keep identifiers and counts exact.'
          >
            <textarea
              aria-label="Column comparison rules"
              className="code-input"
              rows={5}
              value={columnRules}
              onChange={(event) => setColumnRules(event.target.value)}
            />
          </Field>
          <Field
            label="Top-k ranking policy"
            help='Optional JSON: {"count":10,"orderBy":[{"column":"total","direction":"desc"}],"referenceComplete":true}. The reference must contain the complete candidate pool, including boundary ties. Matching scores alone cannot validate unknown candidates.'
          >
            <textarea
              aria-label="Top-k ranking policy"
              className="code-input"
              rows={4}
              value={topK}
              onChange={(event) => setTopK(event.target.value)}
              placeholder="Leave blank for complete-result comparison"
            />
          </Field>
          <Field
            label="Table ordering"
            help="Expected uses the order declared in each typed expected answer. Ordered enforces row positions, allowing ties for the specified ordering keys. Unordered preserves duplicate rows without requiring their positions."
          >
            <select
              aria-label="Table ordering"
              value={settings.tableOrder}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  tableOrder: event.target
                    .value as EvaluatorSettings["tableOrder"],
                })
              }
            >
              <option value="expected">
                Use the expected answer's ordering
              </option>
              <option value="ordered">Require ordered rows</option>
              <option value="unordered">Compare unordered rows</option>
            </select>
          </Field>
          <Field label="Ordering keys">
            <input
              aria-label="Ordering keys"
              value={settings.orderBy?.join(", ") ?? ""}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  orderBy: event.target.value.trim()
                    ? event.target.value
                        .split(",")
                        .map((key) => key.trim())
                        .filter(Boolean)
                    : undefined,
                })
              }
              placeholder="Column names separated by commas"
            />
          </Field>
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.allowColumnPermutation}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  allowColumnPermutation: event.target.checked,
                })
              }
            />
            Allow columns in a different order
          </label>
          <Field
            label="Question-specific overrides"
            help='A JSON object keyed by question ID. Each entry overrides only that question&apos;s settings. For rounding: {"q1":{"absoluteTolerance":0.005}}. For reviewed column names: {"q1":{"columnAliases":{"billing_country":["country"]}}}. Aliases preserve value, row, and ordering checks. Preview saved answers before publishing.'
          >
            <textarea
              aria-label="Question-specific evaluator overrides"
              className="code-input"
              rows={7}
              value={overrides}
              onChange={(event) => setOverrides(event.target.value)}
            />
          </Field>
        </div>
      </details>
      <details className="disclosure">
        <summary>Evaluator calibration cases</summary>
        <Field
          label="Known verdict examples"
          help='JSON array: [{"id":"rounded-value","questionId":"q1","answer":12.34,"expectedStatus":"correct","note":"Accepted currency precision"}]. Include acceptable variants and nearby wrong answers. These cases test the evaluator without calling a target agent.'
        >
          <textarea
            aria-label="Evaluator calibration cases"
            className="code-input"
            rows={7}
            value={cases}
            onChange={(event) => setCases(event.target.value)}
          />
        </Field>
      </details>
      <div className="divider" />
      <div className="row">
        <h3>Preview against saved answers</h3>
        <Help label="Evaluator preview">
          Preview evaluates saved answers with this draft. It does not publish
          the draft or change historical scores.
        </Help>
      </div>
      <ReferenceSelector
        revisions={workspace.revisions}
        value={referenceId}
        onChange={setReferenceId}
      />
      <p className="subtle">
        Calibration uses the selected revision, or the latest bank revision when
        no correction is selected. Publication always checks calibration against
        the latest bank revision.
      </p>
      {workspace.runs.some((run) => run.bankId === bankId) ? (
        <div className="selection-list">
          {workspace.runs
            .filter((run) => run.bankId === bankId)
            .map((run) => (
              <label key={run.id} className="check-row">
                <input
                  type="checkbox"
                  checked={runIds.includes(run.id)}
                  onChange={(event) =>
                    setRunIds((ids) =>
                      event.target.checked
                        ? [...ids, run.id]
                        : ids.filter((id) => id !== run.id),
                    )
                  }
                />
                <span>
                  {run.name}
                  <small>
                    {run.bankName} · {date(run.createdAt)}
                  </small>
                </span>
              </label>
            ))}
        </div>
      ) : (
        <p className="subtle">
          Run a bank to create saved answers for evaluator preview.
        </p>
      )}
      <div className="actions">
        <button
          className="button secondary"
          disabled={!!pending}
          onClick={() => {
            void mutate("calibrate");
          }}
        >
          {pending === "calibrate" ? "Checking cases..." : "Check calibration"}
        </button>
        <button
          className="button secondary"
          disabled={!!pending}
          onClick={() => {
            void mutate("save");
          }}
        >
          {pending === "save" ? "Saving..." : "Save draft"}
        </button>
        <button
          className="button secondary"
          disabled={!!pending || !runIds.length}
          onClick={() => {
            void mutate("preview");
          }}
        >
          {pending === "preview" ? "Evaluating..." : "Preview changes"}
        </button>
        <button
          className="button primary"
          disabled={!!pending}
          onClick={() => {
            void mutate("publish");
          }}
        >
          {pending === "publish" ? "Publishing..." : "Publish and activate"}
        </button>
      </div>
      {preview !== null && <EvaluatorPreview preview={preview} />}
      {calibration !== null && <CalibrationResults report={calibration} />}
      <div className="divider" />
      <h3>Published evaluator revisions</h3>
      {revisions.map((revision) => (
        <div className="history-row" key={revision.id}>
          <div>
            <strong>{revision.name}</strong>
            <p>
              Revision {revision.number} · {revision.settings.mode} ·{" "}
              {date(revision.createdAt)}
            </p>
          </div>
          {revision.id === bank.activeEvaluatorRevisionId ? (
            <span className="tag lime">Active</span>
          ) : (
            <button
              className="button secondary"
              onClick={() => {
                void command("evaluators.activate", {
                  bankId,
                  evaluatorRevisionId: revision.id,
                })
                  .then(refresh)
                  .catch(setError);
              }}
            >
              Activate
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
