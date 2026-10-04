import { savedTarget, targetLabel } from "../contracts/targets.js";
import { useEffect, useState } from "react";
import type { Control } from "../contracts.js";
import { command, useResource } from "./api.js";
import { useObservation, mergeEvents } from "./observation-stream.js";
import { EventList } from "./observation-events.js";
import { ReviewDialog } from "./human-review.js";
import { JevAssessment } from "./jev-assessment.js";
import { LlmAssessment, selectLlmAssessment } from "./llm-assessment.js";
import { ResearchPanel } from "./research-observation.js";
import { Answer } from "./answer.js";
import {
  ReferenceSelector,
  selectedReferenceQuestion,
} from "./reference-selector.js";
import {
  ControlButtons,
  DownloadButton,
  ErrorNotice,
  Field,
  Icon,
  JsonView,
  Metric,
  Modal,
  PageHeading,
  Status,
  date,
  duration,
} from "./ui.js";

export function Observe({
  runId,
  sessionId,
  refreshWorkspace,
}: {
  runId: string;
  sessionId?: string;
  refreshWorkspace: () => void;
}) {
  const resource = useObservation("runs.get", { runId });
  const bankDetail = useResource(
    "banks.get",
    { bankId: resource.data?.run.manifest.bank.bankId ?? "" },
    undefined,
    !!resource.data,
  );
  const [selected, setSelected] = useState("");
  const [tab, setTab] = useState("activity");
  const [scoreId, setScoreId] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [exported, setExported] = useState<unknown>(null);
  const [showManifest, setShowManifest] = useState(false);
  const [review, setReview] = useState(false);
  const [rescore, setRescore] = useState(false);
  const [evaluatorId, setEvaluatorId] = useState("");
  const [referenceId, setReferenceId] = useState("");
  const view = resource.data;
  const current =
    view?.results.find((item) => item.id === selected) ??
    view?.results.find((item) => item.status === "running") ??
    view?.results[0];
  const summary =
    view?.attempts.find((item) => item.id === current?.completedAttemptId) ??
    view?.attempts.findLast((item) => item.resultId === current?.id);
  const selectedEvents = useObservation(
    "runs.attempt-events",
    { runId, attemptId: summary?.id ?? "" },
    !!summary,
    ["queued", "running", "pausing", "halting", "cancelling"].includes(
      view?.run.status ?? "",
    ),
  );
  const detail = useResource(
    "runs.attempt",
    { runId, attemptId: summary?.id ?? "" },
    undefined,
    !!summary && (summary.hasOutput || tab === "evidence"),
  );
  const assessmentVersion = JSON.stringify(
    view?.scoreSets.map((scores) => [
      scores.id,
      scores.published,
      scores.assessments.find((item) => item.resultId === current?.id),
    ]) ?? [],
  );
  useEffect(() => {
    if (summary) detail.refresh();
  }, [
    summary?.id,
    summary?.status,
    summary?.finishedAt,
    assessmentVersion,
    detail.refresh,
  ]);
  const control = async (action: string) => {
    setPending(action);
    setError(null);
    try {
      const uncertain = view?.attempts.some(
        (item) =>
          item.status === "interrupted" && item.remoteCompletion === "unknown",
      );
      const acknowledgeDuplicateWork =
        action === "resume" && uncertain
          ? window.confirm(
              "The external agent may still be running. Resume can create duplicate remote work. Continue?",
            )
          : false;
      if (action === "resume" && uncertain && !acknowledgeDuplicateWork) return;
      await command("runs.control", {
        runId,
        action: action as Control,
        acknowledgeDuplicateWork,
      });
      resource.refresh();
      refreshWorkspace();
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(null);
    }
  };
  if (!view)
    return (
      <>
        <ErrorNotice error={resource.error} />
        <div className="loading">Opening recorded observation...</div>
      </>
    );
  const { run, results, attempts, scoreSets } = view;
  const target = savedTarget(run.manifest);
  const external = target.kind === "external";
  const controllingSessionId = sessionId ?? run.researchSessionId;
  const question = run.manifest.questions.find(
    (item) => item.id === current?.questionId,
  );
  const attempt = detail.data?.attempt ?? summary;
  const scoreSet =
    scoreSets.find((item) => item.id === scoreId) ??
    scoreSets.find((item) => item.kind === "original");
  const referenceBank = scoreSet?.referenceBank;
  const referenceQuestion = selectedReferenceQuestion({
    frozen: question,
    questionId: current?.questionId,
    referenceBankId: referenceBank?.id,
    revisions: bankDetail.data?.revisions ?? [],
  });
  const fullAssessment = detail.data?.assessments.find(
    (item) => item.scoreSetId === scoreSet?.id,
  );
  const evaluator =
    fullAssessment?.evaluator ??
    (scoreSet?.kind === "original" ? run.manifest.evaluator : undefined);
  const assessment =
    fullAssessment?.assessment ??
    scoreSet?.assessments.find((item) => item.resultId === current?.id);
  const originalScores = scoreSets.find((item) => item.kind === "original");
  const originalAssessment =
    detail.data?.assessments.find(
      (item) => item.scoreSetId === originalScores?.id,
    )?.assessment ??
    originalScores?.assessments.find((item) => item.resultId === current?.id);
  const llmAssessment = selectLlmAssessment({
    selected: assessment,
    original: originalAssessment,
    resultId: current?.id,
    attemptId: summary?.id,
    selectedIsOriginal: scoreSet?.kind === "original",
  });
  const events = mergeEvents(
    mergeEvents(view.events, detail.data?.events ?? []),
    selectedEvents.data?.events ?? [],
  ).filter(
    (event) =>
      event.attemptId === attempt?.id ||
      (!event.attemptId && event.type !== "usage"),
  );
  const active = [
    "queued",
    "running",
    "pausing",
    "halting",
    "cancelling",
  ].includes(run.status);
  const output = detail.data?.attempt.output;
  const exportAgent = async () => {
    try {
      setExported(await command("runs.export-target", { runId }));
    } catch (cause) {
      setError(cause);
    }
  };
  return (
    <>
      <PageHeading
        eyebrow="Run / Observe"
        title={run.name}
        description={`${run.manifest.bank.name} · ${run.manifest.repetitions} repetition${run.manifest.repetitions === 1 ? "" : "s"} · ${date(run.createdAt)}`}
      >
        <a className="button secondary" href={`#/run?source=${runId}`}>
          Reuse configuration
        </a>
        <button
          className="button secondary"
          onClick={() => {
            void exportAgent();
          }}
        >
          <Icon name="download" size={15} />
          Export target JSON
        </button>
      </PageHeading>
      <ErrorNotice
        error={
          error ??
          resource.error ??
          detail.error ??
          selectedEvents.error ??
          bankDetail.error
        }
      />
      {run.error && <ErrorNotice error={run.error} />}
      {controllingSessionId && (
        <ResearchPanel sessionId={controllingSessionId} selectedRunId={runId} />
      )}
      <section className="observer">
        <div className="observer-heading">
          <div>
            <span className="eyebrow">
              <i
                className={active && !resource.error ? "live-dot" : "quiet-dot"}
              />
              {resource.error
                ? "Connection interrupted"
                : active
                  ? "Live observation"
                  : "Recorded observation"}
            </span>
            <div className="row">
              <h2>Evaluation workspace</h2>
              <Status value={run.status} />
            </div>
          </div>
          {!controllingSessionId && (
            <ControlButtons
              actions={view.allowedActions}
              pending={pending}
              onAction={(action) => {
                void control(action);
              }}
            />
          )}
        </div>
        <div className="metrics">
          <Metric
            label="Questions completed"
            value={`${view.progress.completed} / ${view.progress.total}`}
          />
          <Metric
            label="Selected question"
            value={current ? `Repetition ${current.repetition}` : null}
          />
          <Metric
            label="Input tokens"
            value={summary?.usage?.inputTokens ?? null}
            detail="Selected attempt"
          />
          <Metric
            label="Output tokens"
            value={summary?.usage?.outputTokens ?? null}
            detail="Selected attempt"
          />
          <Metric
            label="Duration"
            value={
              attempt?.finishedAt
                ? duration(
                    new Date(attempt.finishedAt).getTime() -
                      new Date(attempt.startedAt).getTime(),
                  )
                : null
            }
            detail="Selected attempt"
          />
        </div>
        <div className="configuration-strip">
          <span>
            <Icon name="agent" size={15} />
            <strong>{targetLabel(target)}</strong>
          </span>
          <span>
            <Icon name="tool" size={15} />
            {target.kind === "managed"
              ? `${target.agent.tools.length} allowed tools`
              : "Internal activity managed externally"}
          </span>
          <span>
            <Icon name="shield" size={15} />
            Evaluator r{run.manifest.evaluator.number}
          </span>
          <button className="text-button" onClick={() => setShowManifest(true)}>
            Frozen configuration
          </button>
        </div>
        <div className="observation-columns">
          <aside className="question-queue">
            <div className="section-label">
              Question queue <span>{results.length}</span>
            </div>
            {results.map((result) => {
              const q = run.manifest.questions.find(
                (item) => item.id === result.questionId,
              );
              const graded = scoreSet?.assessments.find(
                (item) => item.resultId === result.id,
              );
              return (
                <button
                  key={result.id}
                  className={`queue-item ${current?.id === result.id ? "selected" : ""}`}
                  onClick={() => setSelected(result.id)}
                >
                  <span
                    className={`queue-dot ${graded?.deterministic.status ?? result.status}`}
                  />
                  <span>
                    <span className="queue-id">
                      {result.questionId} <small>R{result.repetition}</small>
                    </span>
                    <strong>{q?.text ?? result.questionId}</strong>
                    <small>
                      {graded?.deterministic.status ?? result.status}
                    </small>
                  </span>
                </button>
              );
            })}
            <div className="queue-footer">
              Completed results stay saved when you resume interrupted work.
            </div>
          </aside>
          <section className="activity-panel">
            <div className="question-focus">
              <div className="eyebrow">
                {question?.id ?? "Question"} · Repetition{" "}
                {current?.repetition ?? 1}
              </div>
              <h2>{question?.text ?? "Waiting for a question"}</h2>
              {question?.context && <p>{question.context}</p>}
            </div>
            <div className="tabs" role="tablist" aria-label="Question evidence">
              {["activity", "answer", "evidence"].map((value) => (
                <button
                  role="tab"
                  aria-selected={tab === value}
                  key={value}
                  onClick={() => setTab(value)}
                >
                  {external && value === "activity"
                    ? "Request activity"
                    : value[0]?.toUpperCase() + value.slice(1)}
                </button>
              ))}
            </div>
            {external && (
              <p className="notice">
                Internal activity is managed by the external system. Halt or
                Cancel stops local waiting; remote work can continue.
              </p>
            )}
            <div className="activity-body">
              {tab === "activity" && (
                <EventList
                  events={events}
                  empty="No recorded activity for this attempt yet. Events appear as the runtime reports them."
                />
              )}
              {tab === "answer" &&
                (output ? (
                  <div className="answer-block">
                    <div className="eyebrow">Recorded final answer</div>
                    <Answer value={output.answer} />
                    <details className="disclosure">
                      <summary>Original response text</summary>
                      <pre>{output.text}</pre>
                    </details>
                  </div>
                ) : (
                  <div className="waiting">
                    <Icon name="agent" size={26} />
                    <h3>No final answer recorded</h3>
                    <p>
                      Live messages appear in Activity. This panel shows the
                      sealed final response.
                    </p>
                  </div>
                ))}
              {tab === "evidence" && (
                <>
                  <div className="eyebrow">Attempt evidence</div>
                  <JsonView
                    value={attempt ?? { status: "No attempt recorded" }}
                  />
                  <div className="eyebrow">Attempt history</div>
                  {attempts
                    .filter((item) => item.resultId === current?.id)
                    .map((item) => (
                      <div className="history-row" key={item.id}>
                        <span>
                          Attempt {item.number} · {date(item.startedAt)}
                        </span>
                        <Status value={item.status} />
                      </div>
                    ))}
                </>
              )}
            </div>
          </section>
          <aside className="grading-panel">
            <div className="section-label">
              <span>
                <Icon name="shield" size={15} />
                Evaluation
              </span>
            </div>
            <div className="grading-body">
              <div className="eyebrow">
                {scoreSet?.kind === "rescore"
                  ? "Saved rescore basis"
                  : "Frozen before execution"}
              </div>
              <h3>Expected answer</h3>
              {referenceBank && (
                <p className="subtle">
                  Corrected reference: {referenceBank.name}, revision{" "}
                  {referenceBank.number}. Original run references remain
                  unchanged.
                </p>
              )}
              {referenceBank && !referenceQuestion ? (
                <p className="subtle">Loading selected reference answer...</p>
              ) : (
                <Answer value={referenceQuestion?.expected} />
              )}
              <div className="checklist">
                <div>
                  <Icon name="check" size={14} />
                  <span>
                    Question bank revision{" "}
                    {referenceBank?.number ?? run.manifest.bank.number}
                  </span>
                </div>
                <div>
                  <Icon name="check" size={14} />
                  <span>
                    Evaluator revision{" "}
                    {scoreSet?.evaluator.number ??
                      run.manifest.evaluator.number}
                  </span>
                </div>
                <div>
                  <Icon name="check" size={14} />
                  <span>
                    {evaluator
                      ? `${evaluator.settings.mode} comparison`
                      : "Loading comparison rules..."}
                  </span>
                </div>
              </div>
              <details className="disclosure">
                <summary>Frozen question checks</summary>
                <JsonView
                  value={
                    question && evaluator
                      ? Object.fromEntries(
                          Object.entries({
                            ...evaluator.settings,
                            ...evaluator.settings.questionOverrides?.[
                              question.id
                            ],
                          }).filter(([key]) => key !== "questionOverrides"),
                        )
                      : { state: "Loading selected evaluator rules" }
                  }
                />
              </details>
              <div className="divider" />
              <Field label="Assessment basis">
                <select
                  aria-label="Assessment basis"
                  value={scoreSet?.id ?? ""}
                  onChange={(event) => setScoreId(event.target.value)}
                >
                  {scoreSets.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.kind === "original" ? "Original" : "Rescore"} ·{" "}
                      {item.evaluator.name} r{item.evaluator.number}
                      {item.published ? "" : " · preview"}
                    </option>
                  ))}
                </select>
              </Field>
              {assessment ? (
                <div className={`verdict ${assessment.deterministic.status}`}>
                  <Status value={assessment.deterministic.status} />
                  <p>{assessment.deterministic.explanation}</p>
                  {fullAssessment?.assessment.deterministic.details && (
                    <details>
                      <summary>Comparison details</summary>
                      <JsonView
                        value={fullAssessment.assessment.deterministic.details}
                      />
                    </details>
                  )}
                </div>
              ) : (
                <p className="subtle">
                  No deterministic assessment recorded for this result.
                </p>
              )}
              <div className="divider" />
              <h3>Independent assessments</h3>
              <LlmAssessment
                selection={llmAssessment}
                enabled={run.manifest.judge.enabled}
              />
              <div className="divider" />
              {(view.jevAssessments ?? []).filter(
                (item) => item.resultId === current?.id,
              ).length ? (
                (view.jevAssessments ?? [])
                  .filter((item) => item.resultId === current?.id)
                  .map((item) => (
                    <JevAssessment key={item.id} assessment={item} inspect />
                  ))
              ) : (
                <div className="assessment-row">
                  <span>Jev</span>
                  <strong>
                    {run.manifest.jevJudge ? "Not recorded" : "Disabled"}
                  </strong>
                </div>
              )}
              <div className="divider" />
              <h3>Human review</h3>
              {view.reviews
                .filter((item) => item.resultId === current?.id)
                .map((item) => (
                  <div className="human-review" key={item.id}>
                    <strong>
                      {item.verdict ? "Pass" : "Fail"} · {item.reviewer}
                    </strong>
                    <p>{item.note}</p>
                    <small>{date(item.createdAt)}</small>
                  </div>
                ))}
              <button
                className="button secondary full-width"
                disabled={!current || current.status !== "completed"}
                onClick={() => setReview(true)}
              >
                Add human review
              </button>
              <button
                className="button secondary full-width"
                disabled={!attempts.some((item) => item.status === "completed")}
                onClick={() => {
                  setEvaluatorId(run.manifest.evaluator.id);
                  setReferenceId("");
                  setRescore(true);
                }}
              >
                Rescore saved answers
              </button>
            </div>
          </aside>
        </div>
        <footer className="observer-footer">
          <span>
            <Icon name="shield" size={13} />
            Immutable evidence
          </span>
          <span className="mono">{run.id}</span>
          <span>
            {view.events.length} recorded events · cursor {view.cursor}
          </span>
        </footer>
      </section>
      {showManifest && (
        <Modal
          title="Frozen target configuration"
          onClose={() => setShowManifest(false)}
        >
          <p className="subtle">
            These are the settings saved when this run started.
          </p>
          <JsonView
            value={{
              target: savedTarget(run.manifest),
              repetitions: run.manifest.repetitions,
              limits: run.manifest.limits,
              evaluator: {
                name: run.manifest.evaluator.name,
                revision: run.manifest.evaluator.number,
              },
              digest: run.manifest.digest,
            }}
          />
        </Modal>
      )}
      {exported !== null && (
        <Modal title="Export tested target" onClose={() => setExported(null)}>
          <p className="subtle">
            {external
              ? "This export contains endpoint invocation settings and credential placeholders. The remote agent's prompts, models, and tools are controlled outside this app."
              : "This export contains the frozen agent settings and credential placeholders. It excludes questions and expected answers."}
          </p>
          <DownloadButton filename={`${run.id}-agent.json`} value={exported}>
            Download target JSON
          </DownloadButton>
          <JsonView value={exported} />
        </Modal>
      )}
      {review && current && (
        <ReviewDialog
          runId={runId}
          resultId={current.id}
          scoreSetId={scoreSet?.id}
          onClose={() => setReview(false)}
          onSaved={() => {
            setReview(false);
            resource.refresh();
          }}
        />
      )}
      {rescore && (
        <Modal title="Rescore saved answers" onClose={() => setRescore(false)}>
          <p className="subtle">
            A new score set evaluates the saved answers. Original evidence and
            original scores remain unchanged.
          </p>
          <Field label="Published evaluator">
            <select
              aria-label="Rescore evaluator"
              value={evaluatorId}
              onChange={(event) => setEvaluatorId(event.target.value)}
            >
              {(bankDetail.data?.evaluatorRevisions ?? [])
                .filter((item) => item.bankId === run.manifest.bank.bankId)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · revision {item.number}
                  </option>
                ))}
            </select>
          </Field>
          <ReferenceSelector
            revisions={bankDetail.data?.revisions ?? []}
            value={referenceId}
            onChange={setReferenceId}
          />
          <button
            className="button primary"
            disabled={pending === "rescore"}
            onClick={() => {
              setPending("rescore");
              void command("runs.rescore", {
                runId,
                evaluatorRevisionId: evaluatorId,
                bankRevisionId: referenceId || undefined,
                publish: true,
              })
                .then(() => {
                  resource.refresh();
                  setRescore(false);
                  refreshWorkspace();
                })
                .catch(setError)
                .finally(() => setPending(null));
            }}
          >
            {pending === "rescore" ? "Rescoring..." : "Create score set"}
          </button>
        </Modal>
      )}
    </>
  );
}
