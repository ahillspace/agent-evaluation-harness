import { useState } from "react";
import type { BankRevision, WorkspaceView } from "../contracts.js";
import { useResource } from "./api.js";
import { BankEditor } from "./bank-editor.js";
import { AnswerFormatSummary } from "./answer-format.js";
import { BankEvaluator } from "./bank-evaluator.js";
import { JevProfileEditor } from "./jev-profile.js";
import { DownloadButton, Empty, Icon, PageHeading, date, json } from "./ui.js";

export function Banks({
  workspace,
  refresh,
}: {
  workspace: WorkspaceView;
  refresh: () => void;
}) {
  const [selected, setSelected] = useState<string>("");
  const bank =
    workspace.banks.find((item) => item.id === selected) ?? workspace.banks[0];
  const detail = useResource(
    "banks.get",
    { bankId: bank?.id ?? "" },
    undefined,
    !!bank,
  );
  const revision = detail.data?.revisions.find(
    (item) => item.id === bank?.latestRevisionId,
  );
  const refreshBank = () => {
    refresh();
    detail.refresh();
  };
  const [editing, setEditing] = useState<BankRevision | "new" | null>(null);
  const [tab, setTab] = useState("questions");
  return (
    <>
      <PageHeading
        eyebrow="Evaluation library"
        title="Question banks"
        description="Define the questions and evidence that make a useful answer."
      >
        <button className="button primary" onClick={() => setEditing("new")}>
          <Icon name="plus" size={16} />
          Create bank
        </button>
      </PageHeading>
      {!bank ? (
        <Empty
          title="Start with the questions that matter"
          action={
            <button
              className="button primary"
              onClick={() => setEditing("new")}
            >
              Create your first bank
            </button>
          }
        >
          Write questions and expected answers, or import JSON or CSV. Published
          revisions preserve the basis of every evaluation.
        </Empty>
      ) : (
        <div className="library-layout">
          <aside className="collection-list">
            <div className="section-label">
              Your banks <span>{workspace.banks.length}</span>
            </div>
            {workspace.banks.map((item) => (
              <button
                key={item.id}
                className={`collection-item ${item.id === bank.id ? "selected" : ""}`}
                onClick={() => setSelected(item.id)}
              >
                <Icon name="bank" />
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.questionCount} questions</small>
                </span>
              </button>
            ))}
          </aside>
          <section className="panel bank-content">
            <div className="panel-heading">
              <div>
                <h2>{bank.name}</h2>
                <p>
                  Revision {revision?.number} · Published{" "}
                  {date(revision?.createdAt)}
                </p>
              </div>
              <div className="actions">
                {revision && (
                  <DownloadButton
                    filename={`${bank.name}.json`}
                    value={revision}
                  >
                    Export bank
                  </DownloadButton>
                )}
                <button
                  className="button secondary"
                  onClick={() => revision && setEditing(revision)}
                >
                  Edit questions
                </button>
              </div>
            </div>
            <div className="tabs" role="tablist" aria-label="Bank sections">
              {["questions", "evaluator", "Jev criteria", "history"].map(
                (value) => (
                  <button
                    role="tab"
                    aria-selected={tab === value}
                    key={value}
                    onClick={() => setTab(value)}
                  >
                    {value[0]?.toUpperCase()}
                    {value.slice(1)}
                  </button>
                ),
              )}
            </div>
            {tab === "questions" && (
              <div className="question-table">
                <div className="table-caption">
                  Expected values stay private to the evaluator. The target
                  receives the question, public context, and recorded answer
                  format.
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Question</th>
                      <th>Expected answer</th>
                      <th>Tags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {revision?.questions.map((question) => (
                      <tr key={question.id}>
                        <td>
                          <span className="mono subtle">{question.id}</span>
                          <p>{question.text}</p>
                          <AnswerFormatSummary format={question.answerFormat} />
                        </td>
                        <td>
                          <code>
                            {typeof question.expected === "string"
                              ? question.expected
                              : json(question.expected)}
                          </code>
                        </td>
                        <td>
                          {question.tags.map((tag) => (
                            <span className="tag" key={tag}>
                              {tag}
                            </span>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {tab === "evaluator" && detail.data?.bank.id === bank.id && (
              <BankEvaluator
                key={bank.id}
                workspace={{
                  ...workspace,
                  evaluatorRevisions: detail.data?.evaluatorRevisions ?? [],
                  evaluatorDrafts: detail.data?.evaluatorDrafts ?? [],
                  revisions: detail.data.revisions,
                }}
                bankId={bank.id}
                refresh={refreshBank}
              />
            )}
            {tab === "Jev criteria" && detail.data?.bank.id === bank.id && (
              <JevProfileEditor
                key={bank.id}
                bankId={bank.id}
                profiles={detail.data.jevProfiles}
                activeId={detail.data.bank.activeJevProfileRevisionId}
                onSaved={refreshBank}
              />
            )}
            {tab === "history" && (
              <div className="panel-body">
                <h3>Published question revisions</h3>
                {(detail.data?.revisions ?? [])
                  .filter((item) => item.bankId === bank.id)
                  .map((item) => (
                    <div className="history-row" key={item.id}>
                      <div>
                        <strong>Revision {item.number}</strong>
                        <p>
                          {item.questions.length} questions ·{" "}
                          {date(item.createdAt)}
                        </p>
                      </div>
                      <DownloadButton
                        filename={`${item.name}-r${item.number}.json`}
                        value={item}
                      />
                    </div>
                  ))}
              </div>
            )}
          </section>
        </div>
      )}
      {editing && (
        <BankEditor
          source={editing}
          onClose={() => setEditing(null)}
          onSaved={(value) => {
            setSelected(value.bankId);
            setEditing(null);
            refreshBank();
          }}
        />
      )}
    </>
  );
}
