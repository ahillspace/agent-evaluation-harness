import { useEffect, useRef, useState } from "react";
import type { JevJudgeSelection, WorkspaceView } from "../contracts.js";
import { command, useResource } from "./api.js";
import { useObservation } from "./observation-stream.js";
import { restoreJevPreviews, type JevPreview } from "./jev-previews.js";
import { JevAssessment } from "./jev-assessment.js";
import { JevConfiguration } from "./jev-configuration.js";
import { ErrorNotice, Modal } from "./ui.js";

export function JudgeSavedAnswers({
  runId,
  workspace,
  onClose,
  onSaved,
}: {
  runId: string;
  workspace: WorkspaceView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const resource = useObservation("runs.get", { runId });
  const bank = useResource(
    "banks.get",
    { bankId: resource.data?.run.manifest.bank.bankId ?? "" },
    undefined,
    !!resource.data,
  );
  const [configuration, setConfiguration] = useState<JevJudgeSelection>({
    connectionId: "",
    model: "jev-1.13.0",
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [previews, setPreviews] = useState<JevPreview[]>([]);
  const [pending, setPending] = useState("");
  const [error, setError] = useState<unknown>(null);
  const keys = useRef(new Map<string, string>());
  const run = resource.data?.run;
  useEffect(() => {
    if (run?.manifest.jevJudge) {
      const saved = run.manifest.jevJudge;
      setConfiguration({
        connectionId: saved.connection.connectionId,
        model: saved.model,
        profileRevisionId: saved.profile.id,
      });
    }
  }, [run?.manifest]);
  useEffect(() => {
    setPreviews((current) =>
      restoreJevPreviews(current, resource.data?.jevAssessments ?? []),
    );
  }, [resource.data?.jevAssessments]);
  const attempts =
    resource.data?.attempts.filter(
      (attempt) => attempt.status === "completed" && attempt.hasOutput,
    ) ?? [];
  const pendingPreviews =
    resource.data?.jevAssessments.filter(
      (item) =>
        item.kind === "rejudge" && !item.published && item.status === "pending",
    ).length ?? 0;
  const describe = (attemptId: string) => {
    const attempt = attempts.find((item) => item.id === attemptId);
    const result = resource.data?.results.find(
      (item) => item.id === attempt?.resultId,
    );
    const question = run?.manifest.questions.find(
      (item) => item.id === result?.questionId,
    );
    return `${question?.text ?? result?.questionId ?? "Saved answer"} · repetition ${result?.repetition ?? ""}`;
  };
  const preview = async () => {
    setError(null);
    try {
      for (let index = 0; index < selected.length; index++) {
        const attemptId = selected[index]!;
        setPending(
          `Judging saved answer ${index + 1} of ${selected.length}...`,
        );
        const key = JSON.stringify({ attemptId, configuration });
        if (!keys.current.has(key)) keys.current.set(key, crypto.randomUUID());
        const result = await command("jev.preview", {
          runId,
          attemptId,
          configuration,
          idempotencyKey: keys.current.get(key),
        });
        setPreviews((current) => [
          ...current.filter((item) => item.id !== result.id),
          result,
        ]);
      }
    } catch (cause) {
      setError(cause);
    } finally {
      setPending("");
    }
  };
  const publish = async () => {
    setError(null);
    setPending("Saving assessment previews...");
    try {
      for (const item of previews.filter((item) => !item.published)) {
        const saved = await command("jev.publish", { assessmentId: item.id });
        setPreviews((current) =>
          current.map((entry) => (entry.id === saved.id ? saved : entry)),
        );
      }
      onSaved();
    } catch (cause) {
      setError(cause);
    } finally {
      setPending("");
    }
  };
  return (
    <Modal
      title="Judge saved answers"
      onClose={() => {
        if (!pending) onClose();
      }}
    >
      <p>
        Preview sends selected answers, expected answers, and their full
        recorded traces to TypeSafe for paid classification. It does not rerun
        the target. Save preserves the same assessments without another judge
        call.
      </p>
      <ErrorNotice error={error ?? resource.error ?? bank.error} />
      {!run ? (
        <p className="loading">Loading saved evidence...</p>
      ) : (
        <div className="stack">
          <fieldset disabled={!!pending} className="judge-fieldset">
            <JevConfiguration
              value={configuration}
              onChange={setConfiguration}
              connections={workspace.connections}
              bank={bank.data ?? undefined}
              onPublished={bank.refresh}
            />
            <h3>Recorded answers</h3>
            <div className="actions">
              <button
                className="text-button"
                onClick={() => setSelected(attempts.map((item) => item.id))}
              >
                Select all
              </button>
              <button className="text-button" onClick={() => setSelected([])}>
                Clear selection
              </button>
            </div>
            <div className="saved-answer-list">
              {attempts.map((attempt) => (
                <label className="check-row" key={attempt.id}>
                  <input
                    type="checkbox"
                    aria-label={`Judge ${describe(attempt.id)}`}
                    checked={selected.includes(attempt.id)}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, attempt.id]
                          : current.filter((id) => id !== attempt.id),
                      )
                    }
                  />
                  <span>{describe(attempt.id)}</span>
                </label>
              ))}
            </div>
            {!attempts.length && (
              <p className="subtle">
                This run has no completed answers available for judging.
              </p>
            )}
          </fieldset>
          <div className="actions">
            <button
              className="button primary"
              disabled={
                !!pending || !selected.length || !configuration.connectionId
              }
              onClick={() => {
                void preview();
              }}
            >
              Preview {selected.length || "selected"} saved{" "}
              {selected.length === 1 ? "answer" : "answers"}
            </button>
            {previews.some((item) => !item.published) && (
              <button
                className="button secondary"
                disabled={!!pending}
                onClick={() => {
                  void publish();
                }}
              >
                Save all assessment previews
              </button>
            )}
          </div>
          {pending && <p role="status">{pending}</p>}
          {pendingPreviews > 0 && (
            <p role="status">
              {pendingPreviews} saved{" "}
              {pendingPreviews === 1 ? "preview is" : "previews are"} still
              pending. Completed responses appear here automatically.
            </p>
          )}
          {previews.length > 0 && (
            <section className="stack">
              <h3>Assessment preview</h3>
              {previews.map((item) => (
                <div className="panel-body panel" key={item.id}>
                  <h4>{describe(item.attemptId)}</h4>
                  <JevAssessment assessment={item} inspect />
                </div>
              ))}
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}
