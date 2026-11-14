import { useState } from "react";
import type {
  AssessmentPass,
  AssessmentPassObservation,
  Control,
  RunView,
  WorkspaceView,
} from "../contracts.js";
import { command, useResource } from "./api.js";
import { useRunObservation } from "./run-observation.js";
import {
  AssessmentScore,
  AssessmentSelector,
  assessmentLabels,
  selectedAssessment,
} from "./assessment-controls.js";
import { AssessmentDialog } from "./assessment-dialog.js";
import { ReviewDialog } from "./human-review.js";
import { RunQuestions } from "./observation-questions.js";
import { RunPerformanceSummary } from "./run-performance.js";
import { RunConfiguration } from "./run-configuration.js";
import { ResearchPanel } from "./research-observation.js";
import { RetryFailures } from "./retry-failures.js";
import { RetryResults } from "./retry-results.js";
import { RunRecoveryNotice, useRunRecovery } from "./run-recovery.js";
import {
  ControlButtons,
  DownloadButton,
  ErrorNotice,
  Help,
  JsonView,
  Modal,
  PageHeading,
  Status,
  Tabs,
  date,
} from "./ui.js";

export { matchesQuestionFilter } from "./observation-questions.js";
export function Observe({
  runId,
  sessionId,
  refreshWorkspace,
  workspace,
  initialResultId,
  initialAssessmentId,
}: {
  runId: string;
  sessionId?: string;
  refreshWorkspace: () => void;
  workspace?: WorkspaceView;
  initialResultId?: string;
  initialAssessmentId?: string;
}) {
  const resource = useRunObservation(runId);
  const [section, setSection] = useState("questions");
  const [selectedId, setSelectedId] = useState(initialAssessmentId ?? "");
  const [selectedResultId, setSelectedResultId] = useState(
    initialResultId ?? "",
  );
  const [assessing, setAssessing] = useState(false);
  const [review, setReview] = useState<{
    view: RunView;
    pass: AssessmentPassObservation;
    resultId?: string;
  } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [exported, setExported] = useState<AssessmentPass | null>(null);
  const [error, setError] = useState<unknown>(null);
  const recovery = useRunRecovery({
    workspaceId: workspace?.workspaceId,
    runId,
    onAcknowledged: () => {
      setSelectedId("");
      resource.refresh();
      refreshWorkspace();
    },
  });
  const view = resource.data;
  const currentPass = selectedAssessment(
    view?.assessmentPasses ?? [],
    selectedId || view?.selectedAssessmentPassId,
  );
  const passDetail = useResource(
    "runs.assessment",
    {
      runId,
      passId: currentPass?.id ?? "",
      expectedObservationRevision: currentPass?.observationRevision,
    },
    undefined,
    !!currentPass &&
      currentPass.status !== "running" &&
      section === "questions",
  );
  const detail =
    passDetail.data?.observationRevision === currentPass?.observationRevision
      ? passDetail.data
      : null;
  if (!view)
    return (
      <>
        <ErrorNotice error={resource.error} />
        <div className="loading">Opening recorded observation...</div>
      </>
    );
  const { run } = view;
  const researchSession =
    view.controllingJob?.kind === "research"
      ? view.controllingJob.id
      : (sessionId ?? run.researchSessionId);
  const researchControls = view.controllingJob?.kind === "research";
  const passes = view.assessmentPasses ?? [];
  const pass = currentPass;
  const refresh = () => {
    resource.refresh();
    refreshWorkspace();
  };
  const select = (id: string) => {
    setSelectedId(id);
    refresh();
  };
  const saved = (id: string) => {
    setAssessing(false);
    setReview(null);
    select(id);
    void command("runs.select-assessment", { runId, passId: id })
      .then(refresh)
      .catch(setError);
  };
  const control = async (action: string) => {
    if (action === "resume") {
      if (recovery.request) {
        await recovery.replay();
        return;
      }
      const uncertain = view.resumeEligibility?.requiresAcknowledgment ?? false;
      const acknowledgeDuplicateWork = uncertain
        ? window.confirm(
            "Previous attempts might still be running. Resume can repeat remote work. Continue?",
          )
        : false;
      if (uncertain && !acknowledgeDuplicateWork) return;
      await recovery.submit({
        operation: "runs.control",
        input: {
          runId,
          action: "resume",
          acknowledgeDuplicateWork,
          idempotencyKey: crypto.randomUUID(),
          expectedExecutionId: run.execution?.id ?? run.id,
        },
      });
      return;
    }
    setPending(action);
    setError(null);
    try {
      await command("runs.control", {
        runId,
        action: action as Control,
      });
      refresh();
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(null);
    }
  };
  const canAssess = view.progress.completed > 0;
  const parent = passes.find((item) => item.id === pass?.parentPassId);
  return (
    <div className="observation-page">
      <PageHeading
        title={run.name}
        description={`${run.manifest.bank.name} · ${run.manifest.repetitions} repetition${run.manifest.repetitions === 1 ? "" : "s"} · ${date(run.createdAt)}`}
      >
        <Status value={run.status} />
        {!researchControls && (
          <ControlButtons
            actions={(
              view.controllingJob?.allowedActions ?? view.allowedActions
            ).filter(
              (action) =>
                action !== "resume" || (recovery.ready && !recovery.request),
            )}
            pending={pending ?? (recovery.busy ? "resume" : null)}
            onAction={(action) => {
              void control(action);
            }}
          />
        )}
        {researchControls &&
          section !== "research" &&
          !!view.controllingJob?.allowedActions.length && (
            <button
              className="button secondary"
              onClick={() => setSection("research")}
            >
              Research controls
            </button>
          )}
      </PageHeading>
      <ErrorNotice error={error ?? resource.error ?? passDetail.error} />
      <RunRecoveryNotice recovery={recovery} />
      <RetryResults view={view} />
      <section className="run-progress" aria-label="Run progress">
        <strong>
          {view.progress.completed} / {view.progress.total} answered
        </strong>
        <span>
          {view.progress.failed} execution failure
          {view.progress.failed === 1 ? "" : "s"}
        </span>
        <span>
          {view.progress.total - view.progress.completed - view.progress.failed}{" "}
          unfinished
        </span>
        <RetryFailures view={view} recovery={recovery} />
      </section>
      <section className="run-score-toolbar" aria-label="Selected saved score">
        <div className="selected-score-identity">
          <span className="field-label">Saved score</span>
          <h2>{pass?.name ?? "Assessment pending"}</h2>
          {pass && (
            <div className="selected-score-source">
              <span>{assessmentLabels[pass.source]}</span>
              <Status value={pass.status} />
            </div>
          )}
          {passes.length > 1 && (
            <AssessmentSelector
              runId={runId}
              passes={passes}
              selectedId={pass?.id}
              onSaved={select}
            />
          )}
        </div>
        <AssessmentScore pass={pass} />
        <div className="selected-score-actions">
          <div className="actions">
            <button
              className="button secondary"
              disabled={!canAssess}
              title={
                !canAssess
                  ? "Record at least one completed answer first."
                  : undefined
              }
              onClick={() => setAssessing(true)}
            >
              Score saved answers
            </button>
            <Help label="Score saved answers">
              Create a new named score from saved answers without running the
              agent again. Choose answer rules or a model judge. Earlier scores
              remain available.
            </Help>
          </div>
          <div className="actions">
            <button
              className="button secondary"
              disabled={!pass || pass.status === "running"}
              title={
                !pass
                  ? "Wait for the first saved score."
                  : pass.status === "running"
                    ? "Wait for this assessment to finish."
                    : undefined
              }
              onClick={() => {
                if (pass) setReview({ view, pass });
              }}
            >
              Review judgments
            </button>
            <Help label="Review judgments">
              Check individual judgments, add notes, or correct a verdict. Save
              your changes as a separate human review; the original score stays
              available.
            </Help>
          </div>
        </div>
      </section>
      {!canAssess && (
        <p className="subtle">
          Scoring becomes available after an answer is recorded.
        </p>
      )}
      <Tabs
        label="Run sections"
        value={section}
        onChange={setSection}
        panelClassName="run-section"
        items={[
          { value: "questions", label: "Questions" },
          { value: "summary", label: "Summary" },
          ...(researchSession
            ? [{ value: "research", label: "Research" }]
            : []),
          { value: "configuration", label: "Configuration" },
        ]}
      >
        {section === "summary" && (
          <div className="stack">
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>{pass?.name ?? "Assessment pending"}</h2>
                  <p>
                    {pass
                      ? assessmentLabels[pass.source]
                      : "The first score appears as answers are recorded."}
                  </p>
                </div>
                <div className="actions">
                  {pass && (
                    <button
                      className="button secondary"
                      onClick={() => {
                        void command("runs.export-assessment", {
                          runId,
                          passId: pass.id,
                          expectedObservationRevision: pass.observationRevision,
                        })
                          .then(setExported)
                          .catch(setError);
                      }}
                    >
                      Export score
                    </button>
                  )}
                </div>
              </div>
              <div className="panel-body score-overview">
                <AssessmentScore pass={pass} detailed />
              </div>
              {pass?.parentPassId && (
                <div className="panel-body review-comparison">
                  <span>Based on {parent?.name ?? "a saved assessment"}</span>
                  {parent && (
                    <>
                      <span>
                        Before: {parent.coverage.correct} /{" "}
                        {parent.coverage.judged} correct
                      </span>
                      <span>
                        After: {pass.coverage.correct} / {pass.coverage.judged}{" "}
                        correct
                      </span>
                    </>
                  )}
                  <span>
                    {pass.coverage.reviewed} reviewed ·{" "}
                    {pass.coverage.overridden} changed
                  </span>
                </div>
              )}
              {pass &&
                (pass.coverage.errors > 0 || pass.coverage.unjudged > 0) &&
                pass.source !== "human" &&
                pass.status !== "running" && (
                  <div className="panel-body">
                    <button
                      className="button secondary"
                      disabled={!!pending || !(pass.retryableJudgments ?? 0)}
                      title={pass.retryUnavailableReason}
                      onClick={() => {
                        setPending("retry-assessment");
                        void command("runs.retry-assessment", {
                          runId,
                          passId: pass.id,
                          expectedObservationRevision: pass.observationRevision,
                        })
                          .then((value) => saved(value.id))
                          .catch(setError)
                          .finally(() => setPending(null));
                      }}
                    >
                      {pending === "retry-assessment"
                        ? "Assessing missing judgments..."
                        : "Retry missing scores"}
                    </button>
                    <p className="subtle">
                      {pass.retryUnavailableReason ??
                        "Creates another saved score. Successful judgments carry forward; recorded answers are assessed again only where a judgment is missing."}
                    </p>
                  </div>
                )}
            </section>
            <RunPerformanceSummary performance={view.performance} />
          </div>
        )}
        {section === "questions" && (
          <RunQuestions
            view={view}
            pass={pass}
            assessmentDetail={detail ?? undefined}
            selectedResultId={selectedResultId}
            onSelectResult={setSelectedResultId}
            onReview={(resultId) => {
              if (pass) setReview({ view, pass, resultId });
            }}
          />
        )}
        {section === "research" && researchSession && (
          <ResearchPanel sessionId={researchSession} selectedRunId={runId} />
        )}
        {section === "configuration" && <RunConfiguration view={view} />}
      </Tabs>
      {assessing && (
        <AssessmentDialog
          view={view}
          workspace={workspace}
          onClose={() => setAssessing(false)}
          onSaved={saved}
        />
      )}
      {review && (
        <ReviewDialog
          view={review.view}
          pass={review.pass}
          resultId={review.resultId}
          onClose={() => setReview(null)}
          onSaved={saved}
        />
      )}
      {exported !== null && (
        <Modal title="Export saved score" onClose={() => setExported(null)}>
          <DownloadButton
            filename={`${exported.runId}-${exported.id}.json`}
            value={exported}
          >
            Download score JSON
          </DownloadButton>
          <JsonView value={exported} />
        </Modal>
      )}
    </div>
  );
}
