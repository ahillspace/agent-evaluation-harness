import type { BankRevision, WorkspaceView } from "../contracts.js";
import type { SetupDraftProps } from "./setup-types.js";
import { Field } from "./ui.js";

export function RunQuestions({
  draft,
  set,
  setDraft,
  bank,
  published,
  workspace,
}: SetupDraftProps & {
  bank?: BankRevision;
  published: Array<{ id: string; name: string; number: number; count: number }>;
  workspace: Pick<WorkspaceView, "banks" | "connections">;
}) {
  return (
    <>
      <Field label="Run name" required>
        <input
          aria-label="Run name"
          value={draft.name}
          onChange={(event) => set("name", event.target.value)}
        />
      </Field>
      <Field label="Question bank" required>
        <select
          aria-label="Question bank"
          value={draft.bankRevisionId}
          onChange={(event) => {
            const selected = workspace.banks.find(
              (item) => item.latestRevisionId === event.target.value,
            );
            setDraft((value) => ({
              ...value,
              bankId: selected?.id ?? draft.bankId,
              bankRevisionId: event.target.value,
              evaluatorRevisionId: selected?.activeEvaluatorRevisionId ?? "",
              jevSelection: {
                ...value.jevSelection,
                profileRevisionId: selected?.activeJevProfileRevisionId,
              },
              questionIds: [],
            }));
          }}
        >
          <option value="">Choose a bank</option>
          {published.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · revision {item.number} · {item.count} questions
            </option>
          ))}
        </select>
      </Field>
      {bank && (
        <div>
          <div className="row">
            <h3>Question selection</h3>
            <button
              className="text-button"
              onClick={() => set("questionIds", [])}
            >
              Use all {bank.questions.length}
            </button>
          </div>
          <p className="subtle">
            {draft.questionIds.length
              ? `${draft.questionIds.length} selected`
              : "All questions selected"}
            . Clear a question to customize the set.
          </p>
          <div className="selection-list">
            {bank.questions.map((question) => (
              <label key={question.id} className="check-row">
                <input
                  type="checkbox"
                  checked={
                    !draft.questionIds.length ||
                    draft.questionIds.includes(question.id)
                  }
                  onChange={(event) => {
                    const ids = draft.questionIds.length
                      ? draft.questionIds
                      : bank.questions.map((item) => item.id);
                    const next = event.target.checked
                      ? [...ids, question.id]
                      : ids.filter((id) => id !== question.id);
                    if (next.length) set("questionIds", next);
                  }}
                />
                <span>
                  {question.text}
                  <small>{question.id}</small>
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
