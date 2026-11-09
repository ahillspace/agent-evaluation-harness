import { useEffect, useReducer, useRef, useState } from "react";
import type {
  BankDetail,
  BankRevision,
  EvaluatorSettings,
  Question,
  WorkspaceView,
} from "../contracts.js";
import { command, useResource } from "./api.js";
import {
  bankDraftKey,
  bankDraftsEqual,
  bankAuthoringReducer,
  decodeBankDraft,
  encodeBankDraft,
  initialBankDraft,
  removeDraftQuestion,
  saveDraftQuestion,
  type BankDraft,
} from "./bank-draft.js";
import { BankEditor } from "./bank-editor.js";
import { BankQuestions } from "./bank-questions.js";
import { BankGrading } from "./bank-grading.js";
import { BankFindings } from "./bank-findings.js";
import { BankHistory } from "./bank-history.js";
import { BankImportDialog } from "./bank-import-dialog.js";
import { BankPublicationReview } from "./bank-publication-review.js";
import type { BankImport } from "./bank-import.js";
import { ErrorNotice, Field, Modal, Tabs, date, json } from "./ui.js";

function storedDraft(key: string | undefined): BankDraft | undefined {
  if (!key || typeof sessionStorage === "undefined") return undefined;
  try {
    return decodeBankDraft(sessionStorage.getItem(key));
  } catch {
    return undefined;
  }
}
export function BankWorkspace({
  workspace,
  bankId,
  detail,
  refresh,
  onPublished,
}: {
  workspace: WorkspaceView;
  bankId: string;
  detail?: BankDetail;
  refresh: () => void;
  onPublished: (bankId: string) => void;
}) {
  const key = bankDraftKey(workspace.workspaceId, bankId);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [{ draft, importDialog }, dispatchDraft] = useReducer(
    bankAuthoringReducer,
    undefined,
    () => ({
      draft: storedDraft(key) ?? initialBankDraft(detail),
      importDialog: null,
    }),
  );
  const setDraft = (update: BankDraft | ((current: BankDraft) => BankDraft)) =>
    dispatchDraft({ type: "update", update });
  const [tab, setTab] = useState("questions");
  const [editing, setEditing] = useState<{
    question: Question;
    previousId?: string;
  } | null>(null);
  const [history, setHistory] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [pending, setPending] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [storageError, setStorageError] = useState<unknown>(null);
  const findings = useResource(
    "banks.findings",
    { bankId },
    undefined,
    bankId !== "new",
  );
  const revision = detail?.revisions.find(
    (item) => item.id === detail.bank.latestRevisionId,
  );
  const baseline = initialBankDraft(
    detail ? { ...detail, evaluatorDrafts: [] } : undefined,
  );
  const changed = !bankDraftsEqual(draft, baseline);
  const stale =
    !!detail &&
    (draft.baseRevisionId !== detail.bank.latestRevisionId ||
      draft.baseEvaluatorRevisionId !== detail.bank.activeEvaluatorRevisionId);
  useEffect(() => {
    if (!key) return;
    try {
      sessionStorage.setItem(key, encodeBankDraft(draft));
      setStorageError(null);
    } catch {
      setStorageError(
        new Error(
          "This draft remains open, but browser storage cannot save it. Keep this page open until you publish or export the draft.",
        ),
      );
    }
  }, [key, draft]);
  const editQuestion = (id: string) => {
    const question = draft.questions.find((item) => item.id === id);
    if (question) setEditing({ question, previousId: id });
    else
      setError(
        new Error(
          "This question is not in the current draft. Restore its revision from History to edit it.",
        ),
      );
  };
  const add = () => {
    let index = draft.questions.length + 1;
    while (draft.questions.some((item) => item.id === `q${index}`)) index++;
    setEditing({
      question: { id: `q${index}`, text: "", expected: "", tags: [] },
    });
  };
  const imported = (value: BankImport, mode: "replace" | "append") => {
    dispatchDraft({
      type: "import",
      value,
      mode,
      importName: bankId === "new",
    });
  };
  const publish = async () => {
    setPending("publish");
    setError(null);
    try {
      const published = await command("banks.publish", {
        ...(bankId !== "new" ? { bankId } : {}),
        baseRevisionId: draft.baseRevisionId,
        baseEvaluatorRevisionId: draft.baseEvaluatorRevisionId,
        name: draft.name,
        questions: draft.questions,
        evaluatorName: draft.evaluatorName,
        evaluatorSettings: draft.settings,
      });
      if (!mounted.current) return;
      const next = {
        ...draft,
        questions: published.revision.questions,
        baseRevisionId: published.revision.id,
        baseEvaluatorRevisionId: published.evaluatorRevision.id,
        settings: published.evaluatorRevision.settings,
      };
      setDraft(next);
      setReviewing(false);
      try {
        if (key) sessionStorage.removeItem(key);
        const newKey = bankDraftKey(
          workspace.workspaceId,
          published.revision.bankId,
        );
        if (newKey) sessionStorage.setItem(newKey, encodeBankDraft(next));
      } catch {
        setStorageError(
          new Error(
            "Publication succeeded, but browser storage cannot save this draft. Refresh the bank to reopen the published revision.",
          ),
        );
      }
      onPublished(published.revision.bankId);
    } catch (cause) {
      if (mounted.current) {
        setError(cause);
        refresh();
      }
    } finally {
      if (mounted.current) setPending("");
    }
  };
  const discardDraft = async () => {
    setPending("reload");
    setError(null);
    try {
      const latest =
        bankId === "new" ? undefined : await command("banks.get", { bankId });
      if (!mounted.current) return;
      setDraft(initialBankDraft(latest));
      setDiscarding(false);
      refresh();
    } catch (cause) {
      if (mounted.current) setError(cause);
    } finally {
      if (mounted.current) setPending("");
    }
  };
  const exportPackage = async () => {
    if (!revision) return;
    setPending("export");
    setError(null);
    try {
      const value = await command("banks.export-package", {
        bankRevisionId: revision.id,
        evaluatorRevisionId: detail?.bank.activeEvaluatorRevisionId,
        jevProfileRevisionId: detail?.bank.activeJevProfileRevisionId,
      });
      download(`${revision.name}.json`, value);
    } catch (cause) {
      setError(cause);
    } finally {
      setPending("");
    }
  };
  const publishImportedProfile = async () => {
    if (!draft.importedJevProfile || bankId === "new") return;
    const profile = draft.importedJevProfile;
    setPending("jev");
    setError(null);
    try {
      await command("jev.profiles.publish", {
        bankId,
        ...profile,
        activate: true,
      });
      if (!mounted.current) return;
      setDraft((current) => {
        if (current.importedJevProfile !== profile) return current;
        const next = { ...current };
        delete next.importedJevProfile;
        return next;
      });
      refresh();
    } catch (cause) {
      if (mounted.current) setError(cause);
    } finally {
      if (mounted.current) setPending("");
    }
  };
  const restore = (source: BankRevision) => {
    const ids = new Set(source.questions.map((question) => question.id));
    setDraft({
      ...draft,
      name: source.name,
      questions: structuredClone(source.questions),
      settings: {
        ...draft.settings,
        questionOverrides: Object.fromEntries(
          Object.entries(draft.settings.questionOverrides).filter(([id]) =>
            ids.has(id),
          ),
        ),
        ...(draft.settings.calibrationExamples
          ? {
              calibrationExamples: draft.settings.calibrationExamples.filter(
                (example) => ids.has(example.questionId),
              ),
            }
          : {}),
      },
    });
    setHistory(false);
    setTab("questions");
  };
  return (
    <section className="panel bank-content bank-workspace">
      <div className="panel-heading">
        <div>
          <h2>{draft.name || "New question bank"}</h2>
          <p>
            {draft.questions.length} questions
            {revision
              ? ` - Published revision ${revision.number} - ${date(revision.createdAt)}`
              : " - Unpublished"}
            {changed && (
              <span className="tag bank-draft-status">Draft changes</span>
            )}
          </p>
        </div>
        <div className="actions">
          <button
            className="button secondary"
            disabled={!detail}
            onClick={() => setHistory(true)}
          >
            History
          </button>
          <button
            className="button secondary"
            onClick={() => dispatchDraft({ type: "import-dialog", open: true })}
          >
            Import
          </button>
          <button
            className="button secondary"
            disabled={!revision || !!pending}
            onClick={() => void exportPackage()}
          >
            Export bank
          </button>
          <button
            className="button primary"
            disabled={
              !draft.questions.length ||
              !draft.name.trim() ||
              !draft.evaluatorName.trim() ||
              stale ||
              !!pending ||
              (!changed && bankId !== "new")
            }
            onClick={() => setReviewing(true)}
          >
            Publish changes
          </button>
        </div>
      </div>
      <div className="panel-body stack">
        <ErrorNotice error={error} />
        <ErrorNotice error={storageError} />
        {stale && (
          <p className="notice">
            A question or evaluator revision changed after this draft started.
            Export your draft to keep your edits, then reload published content
            before publishing.
          </p>
        )}
        <details className="disclosure">
          <summary>Bank name and draft actions</summary>
          <Field label="Bank name">
            <input
              aria-label="Bank name"
              value={draft.name}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
          </Field>
          <div className="actions">
            <button
              className="button secondary"
              onClick={() =>
                download(`${draft.name || "question-bank"}-draft.json`, {
                  format: "agent-evaluation-harness/question-bank",
                  version: 1,
                  name: draft.name || "Question bank",
                  questions: draft.questions,
                  evaluator: {
                    name: draft.evaluatorName,
                    settings: draft.settings,
                  },
                  ...(draft.importedJevProfile
                    ? { jevProfile: draft.importedJevProfile }
                    : {}),
                })
              }
            >
              Export draft
            </button>
            <button
              className="button secondary"
              onClick={() => setDiscarding(true)}
            >
              {stale ? "Reload published content" : "Discard bank draft"}
            </button>
          </div>
        </details>
        {bankId === "new" && (
          <Field label="Bank name" required>
            <input
              aria-label="New bank name"
              value={draft.name}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
              placeholder="Sales analytics"
            />
          </Field>
        )}
        {draft.importedJevProfile && (
          <details className="disclosure">
            <summary>
              Review imported Jev profile: {draft.importedJevProfile.name}
            </summary>
            <p className="subtle">
              These private judging criteria remain in your draft until you
              explicitly publish and activate this profile. No judge request
              runs.
            </p>
            <pre className="json-view">
              {json(draft.importedJevProfile.settings)}
            </pre>
            {bankId === "new" ? (
              <p className="subtle">
                Publish the bank first, then publish this profile.
              </p>
            ) : (
              <button
                className="button secondary"
                disabled={!!pending}
                onClick={() => void publishImportedProfile()}
              >
                Publish and activate imported Jev profile
              </button>
            )}
          </details>
        )}
      </div>
      <Tabs
        label="Bank sections"
        value={tab}
        onChange={setTab}
        items={[
          { value: "questions", label: "Questions" },
          { value: "grading", label: "Grading" },
          {
            value: "findings",
            label: `Findings${findings.data?.filter((item) => item.status === "open").length ? ` (${findings.data.filter((item) => item.status === "open").length})` : ""}`,
          },
        ]}
      >
        {tab === "questions" && (
          <BankQuestions
            questions={draft.questions}
            settings={draft.settings}
            findings={findings.data ?? []}
            onEdit={editQuestion}
            onAdd={add}
          />
        )}
        {tab === "grading" && (
          <BankGrading
            workspace={{
              ...workspace,
              evaluatorRevisions: detail?.evaluatorRevisions ?? [],
              evaluatorDrafts: detail?.evaluatorDrafts ?? [],
              revisions: detail?.revisions ?? [],
            }}
            bankId={bankId}
            detail={detail}
            questions={draft.questions}
            evaluatorName={draft.evaluatorName}
            onEvaluatorName={(evaluatorName) =>
              setDraft({ ...draft, evaluatorName })
            }
            settings={draft.settings}
            onSettings={(settings) => setDraft({ ...draft, settings })}
            refresh={refresh}
          />
        )}
        {tab === "findings" &&
          (bankId === "new" ? (
            <p className="panel-body subtle">
              Publish this bank before reporting findings from saved runs.
            </p>
          ) : (
            <BankFindings
              bankId={bankId}
              revision={revision}
              onEditQuestion={editQuestion}
              onSaved={() => {
                findings.refresh();
                refresh();
              }}
            />
          ))}
      </Tabs>
      {editing && (
        <BankEditor
          question={editing.question}
          settings={draft.settings}
          onClose={() => setEditing(null)}
          onSaved={(question: Question, settings: EvaluatorSettings) => {
            setDraft(
              saveDraftQuestion(draft, editing.previousId, question, settings),
            );
            setEditing(null);
          }}
          onRemove={
            editing.previousId
              ? () => {
                  setDraft(removeDraftQuestion(draft, editing.previousId!));
                  setEditing(null);
                }
              : undefined
          }
        />
      )}
      {importDialog && (
        <BankImportDialog
          pristine={bankId === "new" && !changed}
          importError={importDialog.error}
          onClearImportError={() =>
            dispatchDraft({ type: "import-dialog", open: true })
          }
          onClose={() => dispatchDraft({ type: "import-dialog", open: false })}
          onImport={imported}
        />
      )}
      {history && detail && (
        <BankHistory
          detail={detail}
          onClose={() => setHistory(false)}
          onRestore={restore}
          refresh={refresh}
        />
      )}
      {reviewing && (
        <Modal
          title="Review changes before publishing"
          onClose={() => {
            if (!pending) setReviewing(false);
          }}
        >
          <div className="stack">
            <p>
              Publish {draft.questions.length} questions and the current answer
              rules as immutable revisions. Existing runs retain their recorded
              versions.
            </p>
            <BankPublicationReview baseline={baseline} draft={draft} />
            <p className="subtle">
              Publication validates references, public formats, and labeled
              calibration examples against this draft.
            </p>
            <ErrorNotice error={error} />
            <div className="actions">
              <button
                className="button secondary"
                disabled={!!pending}
                onClick={() => setReviewing(false)}
              >
                Keep editing
              </button>
              <button
                className="button primary"
                disabled={!!pending || stale}
                onClick={() => void publish()}
              >
                {pending === "publish"
                  ? "Publishing..."
                  : "Publish question bank and rules"}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {discarding && (
        <Modal
          title="Discard bank draft?"
          onClose={() => {
            if (!pending) setDiscarding(false);
          }}
        >
          <p>
            Your saved draft edits are replaced with the latest published
            questions and active evaluator. Published records remain available.
          </p>
          <ErrorNotice error={error} />
          <div className="actions">
            <button
              className="button secondary"
              disabled={!!pending}
              onClick={() => setDiscarding(false)}
            >
              Keep draft
            </button>
            <button
              className="button danger"
              disabled={!!pending}
              onClick={() => void discardDraft()}
            >
              {pending === "reload"
                ? "Loading published content..."
                : "Discard draft"}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
function download(filename: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([json(value)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
