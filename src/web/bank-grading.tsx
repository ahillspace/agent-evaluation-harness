import { useEffect, useState } from "react";
import {
  evaluatorSettingsSchema,
  type BankDetail,
  type CalibrationReport,
  type EvaluatorSettings,
  type EvaluationPreview,
  type Question,
  type WorkspaceView,
} from "../contracts.js";
import { command, useResource } from "./api.js";
import { CalibrationResults } from "./calibration-results.js";
import { EvaluatorPreview } from "./evaluator-preview.js";
import { JevProfileEditor } from "./jev-profile.js";
import { AppliedRulesJson, SharedGradingFields } from "./question-grading.js";
import {
  ignoredReferencePolicies,
  ReferencePolicyWarning,
} from "./reference-selector.js";
import { ErrorNotice, Field, date } from "./ui.js";

export function BankGrading({
  workspace,
  detail,
  bankId,
  questions,
  evaluatorName,
  onEvaluatorName,
  settings,
  onSettings,
  refresh,
}: {
  workspace: WorkspaceView &
    Pick<BankDetail, "evaluatorRevisions" | "evaluatorDrafts" | "revisions">;
  detail?: BankDetail;
  bankId: string;
  questions: Question[];
  evaluatorName: string;
  onEvaluatorName: (name: string) => void;
  settings: EvaluatorSettings;
  onSettings: (settings: EvaluatorSettings) => void;
  refresh: () => void;
}) {
  const bank = workspace.banks.find((item) => item.id === bankId);
  const [runIds, setRunIds] = useState<string[]>([]);
  const [runOffset, setRunOffset] = useState(0);
  const runPage = useResource(
    "runs.list",
    { bankId, limit: 25, offset: runOffset },
    undefined,
    !!bank,
  );
  useEffect(() => {
    setRunIds([]);
    setRunOffset(0);
  }, [bankId]);
  const [pending, setPending] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [preview, setPreview] = useState<{
    key: string;
    value: EvaluationPreview;
  } | null>(null);
  const [calibration, setCalibration] = useState<{
    key: string;
    value: CalibrationReport;
  } | null>(null);
  const key = JSON.stringify({ bankId, questions, settings });
  const previewKey = JSON.stringify({ key, runIds });
  const warnings = ignoredReferencePolicies(questions);
  const runs = runPage.data?.runs ?? [];
  const active = workspace.evaluatorRevisions.find(
    (revision) => revision.id === bank?.activeEvaluatorRevisionId,
  );
  const check = async (action: "calibrate" | "preview") => {
    setPending(action);
    setError(null);
    try {
      const validated = evaluatorSettingsSchema.parse(settings);
      if (action === "calibrate")
        setCalibration({
          key,
          value: await command("banks.calibrate-draft", {
            questions,
            settings: validated,
          }),
        });
      else
        setPreview({
          key: previewKey,
          value: await command("banks.preview-draft", {
            bankId,
            questions,
            settings: validated,
            runIds,
          }),
        });
    } catch (cause) {
      setError(cause);
    } finally {
      setPending("");
    }
  };
  return (
    <div className="panel-body stack bank-grading">
      <div>
        <h3>Shared grading rules</h3>
        <p className="subtle">
          Questions inherit these defaults unless they have an explicit
          override. Publish questions and rules together from the bank header.
        </p>
      </div>
      <ErrorNotice error={error} />
      <Field label="Grading revision name">
        <input
          aria-label="Evaluator revision name"
          value={evaluatorName}
          onChange={(event) => onEvaluatorName(event.target.value)}
        />
      </Field>
      {warnings.length > 0 && (
        <details className="disclosure">
          <summary>
            {warnings.length} question{warnings.length === 1 ? "" : "s"} with
            inactive reference comparison metadata
          </summary>
          <ReferencePolicyWarning questions={questions} />
        </details>
      )}
      <SharedGradingFields settings={settings} onSettings={onSettings} />
      <details className="disclosure">
        <summary>Calibration examples and publication checks</summary>
        <div className="stack">
          <p className="subtle">
            Examples test known verdicts against the current draft without a
            target or judge request. Failed examples block publication.
          </p>
          <AppliedRulesJson
            label="Calibration examples"
            value={settings.calibrationExamples ?? []}
            onApply={(value) =>
              onSettings(
                evaluatorSettingsSchema.parse({
                  ...settings,
                  calibrationExamples: value ?? [],
                }),
              )
            }
            help={
              'JSON array: [{"id":"rounded-value","questionId":"q1","answer":49.1,"expectedStatus":"correct","note":"Accepted precision"}]. Include accepted variants and nearby wrong answers.'
            }
          />
          <button
            type="button"
            className="button secondary"
            disabled={!!pending}
            onClick={() => {
              void check("calibrate");
            }}
          >
            {pending === "calibrate"
              ? "Checking cases..."
              : "Check calibration"}
          </button>
          {calibration?.key === key && (
            <CalibrationResults report={calibration.value} />
          )}
          {active?.calibration && (
            <details className="disclosure">
              <summary>Active revision's publication calibration</summary>
              <CalibrationResults report={active.calibration} />
            </details>
          )}
        </div>
      </details>
      {bank && (
        <details className="disclosure">
          <summary>Preview grading against saved answers</summary>
          <div className="stack">
            <p className="subtle">
              Compare saved answers with the current question and rule draft.
              Historical evidence and assessments stay unchanged. No target or
              judge request runs.
            </p>
            <ErrorNotice error={runPage.error} />
            {runs.length > 0 ? (
              <div className="selection-list">
                {runs.map((run) => (
                  <label key={run.id} className="check-row">
                    <input
                      type="checkbox"
                      aria-label={`Preview ${run.name}`}
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
                      <small>{date(run.createdAt)}</small>
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="subtle">
                {!runPage.data && !runPage.error
                  ? "Loading saved runs..."
                  : runPage.error
                    ? "Saved runs could not be loaded."
                    : "Run this bank to create saved answers for preview."}
              </p>
            )}
            {runPage.data && runPage.data.total > 25 && (
              <div className="pagination">
                <span>
                  {runOffset + 1}-{runOffset + runs.length} of{" "}
                  {runPage.data.total} runs
                </span>
                <div className="actions">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={!runOffset}
                    onClick={() => setRunOffset(Math.max(0, runOffset - 25))}
                  >
                    Previous runs
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={runPage.data.nextOffset === null}
                    onClick={() =>
                      setRunOffset(runPage.data?.nextOffset ?? runOffset)
                    }
                  >
                    Next runs
                  </button>
                </div>
              </div>
            )}
            {runIds.length > 0 && (
              <p className="subtle">
                {runIds.length} run{runIds.length === 1 ? "" : "s"} selected
                across pages.
              </p>
            )}
            <button
              type="button"
              className="button secondary"
              disabled={!!pending || runIds.length === 0}
              onClick={() => {
                void check("preview");
              }}
            >
              {pending === "preview"
                ? "Evaluating..."
                : "Preview saved answers"}
            </button>
            {preview?.key === previewKey && (
              <EvaluatorPreview preview={preview.value} />
            )}
          </div>
        </details>
      )}
      <details className="disclosure">
        <summary>Optional judge criteria</summary>
        <div className="stack">
          <p className="subtle">
            LLM judge instructions and judge selection are configured in Run.
            Judge assessments remain separate from deterministic grading.
          </p>
          {bank && detail ? (
            <details className="disclosure">
              <summary>Jev profile - published separately</summary>
              <p className="subtle">
                Publishing here activates a separate Jev profile for this bank.
                It does not publish the question and deterministic rule draft.
                Credentials are managed in Settings.
              </p>
              <JevProfileEditor
                key={`${bankId}:${bank.activeJevProfileRevisionId ?? "new"}`}
                bankId={bankId}
                profiles={detail.jevProfiles}
                activeId={bank.activeJevProfileRevisionId}
                onSaved={() => refresh()}
              />
            </details>
          ) : (
            <p className="subtle">
              Publish the bank before creating its optional Jev profile.
              Credentials are managed in Settings.
            </p>
          )}
        </div>
      </details>
    </div>
  );
}
