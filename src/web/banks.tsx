import { useEffect, useState } from "react";
import type { WorkspaceView } from "../contracts.js";
import { useResource } from "./api.js";
import { BankWorkspace } from "./bank-workspace.js";
import { Empty, ErrorNotice, Icon, PageHeading, SectionIntro } from "./ui.js";

export function Banks({
  workspace,
  refresh,
}: {
  workspace: WorkspaceView;
  refresh: () => void;
}) {
  const [selected, setSelected] = useState("");
  const bankId = selected || workspace.banks[0]?.id || "";
  const isNew = bankId === "new";
  const detail = useResource(
    "banks.get",
    { bankId },
    undefined,
    !!bankId && !isNew,
  );
  const selectedBank = workspace.banks.find((bank) => bank.id === bankId);
  const refreshDetail = detail.refresh;
  useEffect(() => {
    refreshDetail();
  }, [
    selectedBank?.latestRevisionId,
    selectedBank?.activeEvaluatorRevisionId,
    selectedBank?.activeJevProfileRevisionId,
    refreshDetail,
  ]);
  return (
    <>
      <PageHeading
        title="Question banks"
        description="Questions, private reference answers, and grading rules."
      >
        <button className="button primary" onClick={() => setSelected("new")}>
          <Icon name="plus" size={16} />
          Create bank
        </button>
      </PageHeading>
      <SectionIntro
        title="Question banks"
        description="Start with a question, its reference answer, and the rules that apply."
        details="The target receives public questions and instructions. Reference answers and grading criteria stay private. Save edits into a draft, preview grading, and publish immutable revisions."
      />
      <ErrorNotice error={detail.error} />
      {!bankId ? (
        <Empty
          title="Start with the questions that matter"
          action={
            <button
              className="button primary"
              onClick={() => setSelected("new")}
            >
              Create your first bank
            </button>
          }
        >
          Write questions and reference answers, or import JSON or CSV.
        </Empty>
      ) : (
        <div className="library-layout">
          <aside className="collection-list" aria-label="Question banks">
            <div className="section-label">
              Your banks <span>{workspace.banks.length}</span>
            </div>
            {workspace.banks.map((bank) => (
              <button
                key={bank.id}
                className={`collection-item ${bank.id === bankId ? "selected" : ""}`}
                aria-pressed={bank.id === bankId}
                onClick={() => setSelected(bank.id)}
              >
                <Icon name="bank" />
                <span>
                  <strong>{bank.name}</strong>
                  <small>
                    {bank.questionCount}{" "}
                    {bank.questionCount === 1 ? "question" : "questions"}
                  </small>
                </span>
              </button>
            ))}
            {isNew && (
              <button
                className="collection-item selected"
                aria-pressed="true"
                onClick={() => setSelected("new")}
              >
                <Icon name="bank" />
                <span>
                  <strong>New bank</strong>
                  <small>Unpublished draft</small>
                </span>
              </button>
            )}
          </aside>
          {isNew || detail.data ? (
            <BankWorkspace
              key={`${workspace.workspaceId ?? ""}:${bankId}`}
              bankId={bankId}
              workspace={workspace}
              detail={detail.data ?? undefined}
              refresh={() => {
                refresh();
                detail.refresh();
              }}
              onPublished={(id) => {
                setSelected(id);
                refresh();
                detail.refresh();
              }}
            />
          ) : (
            <section className="panel bank-content panel-body">
              <p className="subtle">Loading question bank...</p>
            </section>
          )}
        </div>
      )}
    </>
  );
}
