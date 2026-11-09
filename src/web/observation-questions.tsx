import { useEffect, useState } from "react";
import type { AssessmentPass, RunView } from "../contracts.js";
import { savedTarget } from "../contracts/targets.js";
import { useResource } from "./api.js";
import { useObservation, mergeEvents } from "./observation-stream.js";
import { EventList } from "./observation-events.js";
import { Answer } from "./answer.js";
import { JevAssessment } from "./jev-assessment.js";
import { ReportFinding } from "./report-finding.js";
import { failureLabels } from "./retry-failures.js";
import { questionEvidence } from "./question-evidence.js";
import { TokenUsageHelp, UsageValue } from "./run-performance.js";
import {
  ErrorNotice,
  Field,
  JsonView,
  Status,
  Tabs,
  date,
  duration,
} from "./ui.js";

export function matchesQuestionFilter(
  text: string,
  id: string,
  status: string,
  query: string,
  attentionOnly: boolean,
) {
  return (
    `${id} ${text}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()) &&
    (!attentionOnly ||
      [
        "incorrect",
        "error",
        "unscorable",
        "unavailable",
        "unjudged",
        "failed",
        "interrupted",
      ].includes(status))
  );
}

export function RunQuestions({
  view,
  pass,
  onReview,
  selectedResultId,
  onSelectResult,
}: {
  view: RunView;
  pass?: AssessmentPass;
  onReview: (id: string) => void;
  selectedResultId: string;
  onSelectResult: (id: string) => void;
}) {
  const [attemptId, setAttemptId] = useState("");
  const [tab, setTab] = useState(() =>
    ["queued", "running", "pausing", "halting", "cancelling"].includes(
      view.run.status,
    )
      ? "activity"
      : "answer",
  );
  const [query, setQuery] = useState("");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [finding, setFinding] = useState(false);
  const { run, results } = view;
  const questionsById = new Map(
    run.manifest.questions.map((item) => [item.id, item]),
  );
  const judgmentsByResult = new Map(
    pass?.judgments.map((item) => [item.resultId, item]) ?? [],
  );
  const current =
    results.find((item) => item.id === selectedResultId) ??
    results.find((item) => item.status === "running") ??
    results[0];
  const question = questionsById.get(current?.questionId ?? "");
  const evidence = current
    ? questionEvidence(view, current, pass, attemptId)
    : undefined;
  const history = evidence?.history ?? [];
  const summary = evidence?.attempt;
  const detail = useResource(
    "runs.attempt",
    { runId: run.id, attemptId: summary?.id ?? "" },
    undefined,
    !!summary,
  );
  const live = [
    "queued",
    "running",
    "pausing",
    "halting",
    "cancelling",
  ].includes(run.status);
  const events = useObservation(
    "runs.attempt-events",
    { runId: run.id, attemptId: summary?.id ?? "" },
    !!summary,
    live,
  );
  useEffect(() => {
    if (summary) detail.refresh();
  }, [
    summary?.id,
    summary?.status,
    summary?.finishedAt,
    pass?.id,
    detail.refresh,
  ]);
  const judgment = judgmentsByResult.get(current?.id ?? "");
  const reference =
    pass?.configuration.referenceBank?.questions.find(
      (item) => item.id === current?.questionId,
    ) ??
    (!pass || pass.basis.bankRevisionId === run.manifest.bank.id
      ? question
      : undefined);
  const rules =
    pass?.configuration.evaluator ??
    (!pass || pass.basis.evaluatorRevisionId === run.manifest.evaluator.id
      ? run.manifest.evaluator
      : undefined);
  const selectedStatus = (result: RunView["results"][number]) => {
    const selectedJudgment = judgmentsByResult.get(result.id);
    if (selectedJudgment?.attemptId) return selectedJudgment.status;
    if (!pass && result.answerSource) return "completed";
    return ["failed", "interrupted"].includes(result.status)
      ? result.status
      : (selectedJudgment?.status ?? result.status);
  };
  const visible = results.filter((result) =>
    matchesQuestionFilter(
      questionsById.get(result.questionId)?.text ?? "",
      result.questionId,
      selectedStatus(result),
      query,
      attentionOnly,
    ),
  );
  const activity = mergeEvents(
    detail.data?.events ?? [],
    events.data?.events ?? [],
  ).filter((item) => item.attemptId === summary?.id || !item.attemptId);
  const attempt = detail.data?.attempt ?? summary;
  const external = savedTarget(run.manifest).kind === "external";
  const jev = view.jevAssessments?.find(
    (item) => item.id === judgment?.jevAssessmentId,
  );
  const failedEvidence = detail.data?.attempt.failure?.transport;
  const failedText =
    failedEvidence &&
    typeof failedEvidence === "object" &&
    !Array.isArray(failedEvidence) &&
    typeof failedEvidence.text === "string"
      ? failedEvidence.text
      : undefined;
  return (
    <section className="observer">
      <ErrorNotice error={detail.error ?? events.error} />
      <div className="observation-columns">
        <aside className="question-queue">
          <div className="section-label">
            <span>Questions</span>
            <span>
              {view.progress.completed} / {view.progress.total}
            </span>
          </div>
          <div className="queue-search">
            <input
              aria-label="Filter questions"
              placeholder="Filter questions..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button
              className={`text-button ${attentionOnly ? "active" : ""}`}
              aria-pressed={attentionOnly}
              onClick={() => setAttentionOnly(!attentionOnly)}
            >
              Needs attention
            </button>
          </div>
          <div className="queue-items" aria-label="Run questions">
            {visible.map((result) => (
              <button
                key={result.id}
                className={`queue-item ${current?.id === result.id ? "selected" : ""}`}
                aria-current={current?.id === result.id ? "true" : undefined}
                onClick={() => {
                  onSelectResult(result.id);
                  setAttemptId("");
                }}
              >
                <span className={`queue-dot ${selectedStatus(result)}`} />
                <span>
                  <span className="queue-id">
                    {result.questionId} <small>R{result.repetition}</small>
                  </span>
                  <strong>
                    {questionsById.get(result.questionId)?.text ??
                      result.questionId}
                  </strong>
                  <small>{selectedStatus(result)}</small>
                </span>
              </button>
            ))}
            {!visible.length && (
              <p className="waiting-text">No questions match these filters.</p>
            )}
          </div>
        </aside>
        <section className="activity-panel" aria-label="Selected question">
          <div className="question-focus">
            <div className="eyebrow">
              {question?.id ?? "Question"} · Repetition{" "}
              {current?.repetition ?? 1}
            </div>
            <h2>{question?.text ?? "No questions recorded"}</h2>
            {question?.context && (
              <details className="disclosure">
                <summary>Question context</summary>
                <p>{question.context}</p>
              </details>
            )}
          </div>
          <Tabs
            label="Question evidence"
            value={tab}
            onChange={setTab}
            panelClassName="activity-body"
            items={[
              { value: "answer", label: "Answer" },
              {
                value: "activity",
                label: external ? "Request activity" : "Activity",
              },
              { value: "evidence", label: "Attempts" },
            ]}
          >
            {tab === "answer" && (
              <>
                {evidence?.fromRerun && summary && (
                  <p className="answer-provenance">
                    Rerun answer from{" "}
                    <a href={`#/runs/${summary.runId}`}>the linked rerun</a>.
                    Original attempts remain in Attempts.
                  </p>
                )}
                {attemptId &&
                  attemptId !== judgment?.attemptId &&
                  judgment?.attemptId && (
                    <p className="answer-provenance">
                      Showing another recorded attempt. The selected score uses
                      its saved answer.
                    </p>
                  )}
                {detail.data?.attempt.output ? (
                  <Answer value={detail.data.attempt.output.answer} />
                ) : (
                  <p className="waiting-text">
                    No final answer recorded for this attempt.
                  </p>
                )}
                {detail.data?.attempt.output && (
                  <details className="disclosure">
                    <summary>Original response text</summary>
                    <pre>{detail.data.attempt.output.text}</pre>
                  </details>
                )}
                {failedText && (
                  <section className="stack">
                    <p className="notice">
                      Final response saved, but no answer was submitted
                      successfully. This remains an execution failure.
                    </p>
                    <pre className="code-block">{failedText}</pre>
                    <details className="disclosure">
                      <summary>Submission failure evidence</summary>
                      <JsonView value={failedEvidence} />
                    </details>
                  </section>
                )}
              </>
            )}
            {tab === "activity" && (
              <>
                {external && (
                  <p className="notice">
                    Internal activity is managed by the external system. Halt or
                    Cancel stops local waiting; remote work can continue.
                  </p>
                )}
                <EventList
                  events={activity}
                  empty="No recorded activity for this attempt yet."
                />
              </>
            )}
            {tab === "evidence" && (
              <>
                <Field label="Recorded attempt">
                  <select
                    aria-label="Recorded attempt"
                    value={summary?.id ?? ""}
                    onChange={(event) => setAttemptId(event.target.value)}
                  >
                    {history.length ? (
                      history.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.runId === run.id
                            ? "Original attempt"
                            : "Rerun attempt"}{" "}
                          {item.number} · {item.status} · {date(item.startedAt)}
                        </option>
                      ))
                    ) : (
                      <option value="">No attempt recorded</option>
                    )}
                  </select>
                </Field>
                <p className="subtle">
                  Attempts and delayed retries stay recorded individually.
                </p>
                {history.map((item) => (
                  <div className="history-row" key={item.id}>
                    <span>
                      {item.runId === run.id
                        ? "Original attempt"
                        : "Rerun attempt"}{" "}
                      {item.number}
                    </span>
                    <Status value={item.status} />
                    <span>{date(item.startedAt)}</span>
                    {item.failure && (
                      <span>
                        {
                          failureLabels[
                            item.failure.classification?.category ?? "unknown"
                          ]
                        }
                      </span>
                    )}
                  </div>
                ))}
                <details className="disclosure">
                  <summary>Recorded attempt data</summary>
                  <JsonView
                    value={attempt ?? { status: "No attempt recorded" }}
                  />
                </details>
              </>
            )}
          </Tabs>
        </section>
        <aside className="grading-panel">
          <div className="section-label">Selected assessment</div>
          <div className="grading-body">
            <strong>{pass?.name ?? "Awaiting assessment"}</strong>
            {judgment ? (
              <div className={`verdict ${judgment.status}`}>
                <Status value={judgment.status} />
                <p>{judgment.explanation}</p>
              </div>
            ) : (
              <p className="subtle">No judgment recorded for this question.</p>
            )}
            {judgment?.review && (
              <div className="human-review">
                <strong>{judgment.review.reviewer}</strong>
                <p>{judgment.review.note}</p>
                <small>
                  Previously {judgment.review.previousStatus} ·{" "}
                  {date(judgment.review.createdAt)}
                </small>
              </div>
            )}
            {jev && <JevAssessment assessment={jev} inspect />}
            {pass?.source === "deterministic" && judgment?.details && (
              <details className="disclosure">
                <summary>Comparison details</summary>
                <JsonView value={judgment.details} />
              </details>
            )}
            <div className="actions">
              <button
                className="button secondary"
                disabled={!pass || !current}
                title={
                  !pass ? "Wait for the first saved assessment." : undefined
                }
                onClick={() => {
                  if (current) onReview(current.id);
                }}
              >
                Review this question
              </button>
              <button
                className="text-button"
                disabled={!current}
                onClick={() => setFinding(true)}
              >
                Report finding
              </button>
            </div>
            <details className="disclosure inspector-section">
              <summary>Expected answer and comparison rules</summary>
              {reference ? (
                <Answer value={reference.expected} />
              ) : (
                <p className="subtle">Loading this assessment's reference...</p>
              )}
              {rules ? (
                <>
                  <p className="subtle">
                    {rules.name} · revision {rules.number}
                  </p>
                  <JsonView
                    value={{
                      ...rules.settings,
                      ...rules.settings.questionOverrides?.[question?.id ?? ""],
                      questionOverrides: undefined,
                    }}
                  />
                </>
              ) : (
                <p className="subtle">
                  Loading this assessment's comparison rules...
                </p>
              )}
            </details>
            {(judgment?.request || judgment?.response) && (
              <details className="disclosure inspector-section">
                <summary>Assessment request and response</summary>
                <JsonView
                  value={{
                    request: judgment.request,
                    response: judgment.response,
                    configuration: pass?.configuration.judge,
                  }}
                />
              </details>
            )}
            <details className="disclosure inspector-section">
              <summary>Attempt details</summary>
              {attempt?.error && <p className="warning">{attempt.error}</p>}
              <dl className="observation-properties">
                <div>
                  <dt>Status</dt>
                  <dd>{attempt?.status ?? "Not started"}</dd>
                </div>
                <div>
                  <dt>Duration</dt>
                  <dd>
                    {attempt?.finishedAt
                      ? duration(
                          new Date(attempt.finishedAt).getTime() -
                            new Date(attempt.startedAt).getTime(),
                        )
                      : "Unknown"}
                  </dd>
                </div>
                <div>
                  <dt>
                    Input tokens <TokenUsageHelp />
                  </dt>
                  <dd>
                    <UsageValue value={summary?.usage?.uncachedInputTokens} />
                  </dd>
                </div>
                <div>
                  <dt>Output tokens</dt>
                  <dd>
                    <UsageValue value={summary?.usage?.outputTokens} />
                  </dd>
                </div>
                <div>
                  <dt>Cache tokens</dt>
                  <dd>
                    <UsageValue value={summary?.usage?.cachedInputTokens} />
                  </dd>
                </div>
              </dl>
            </details>
          </div>
        </aside>
      </div>
      {finding && current && (
        <ReportFinding
          view={view}
          resultId={current.id}
          passId={pass?.id}
          bankRevisionId={pass?.basis.bankRevisionId}
          onClose={() => setFinding(false)}
        />
      )}
    </section>
  );
}
