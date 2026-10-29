import { useState } from "react";
import type { BankDetail, BankRevision } from "../contracts.js";
import { command } from "./api.js";
import { DownloadButton, ErrorNotice, Modal, date } from "./ui.js";

export function BankHistory({
  detail,
  onClose,
  onRestore,
  refresh,
}: {
  detail: BankDetail;
  onClose: () => void;
  onRestore: (revision: BankRevision) => void;
  refresh: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const activate = async (kind: "evaluator" | "jev", id: string) => {
    setPending(true);
    setError(null);
    try {
      if (kind === "evaluator")
        await command("evaluators.activate", {
          bankId: detail.bank.id,
          evaluatorRevisionId: id,
        });
      else
        await command("jev.profiles.activate", {
          bankId: detail.bank.id,
          profileRevisionId: id,
        });
      refresh();
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal title="Revision history" onClose={onClose}>
      <div className="stack">
        <p className="subtle">
          Published records remain attached to earlier runs. Restoring questions
          creates a draft. Activating rules affects future runs.
        </p>
        <ErrorNotice error={error} />
        <section className="bank-history-section">
          <h3>Question revisions</h3>
          {detail.revisions.map((revision) => (
            <div className="history-row" key={revision.id}>
              <div>
                <strong>Revision {revision.number}</strong>
                <p>
                  {revision.questions.length} questions -{" "}
                  {date(revision.createdAt)}
                </p>
              </div>
              <div className="actions">
                <DownloadButton
                  filename={`${revision.name}-r${revision.number}.json`}
                  value={revision}
                />
                <button
                  className="button secondary"
                  onClick={() => onRestore(revision)}
                >
                  Restore as draft
                </button>
              </div>
            </div>
          ))}
        </section>
        <section className="bank-history-section">
          <h3>Evaluator revisions</h3>
          {detail.evaluatorRevisions.map((revision) => (
            <div className="history-row" key={revision.id}>
              <div>
                <strong>
                  {revision.name} - revision {revision.number}
                </strong>
                <p>{date(revision.createdAt)}</p>
              </div>
              {detail.bank.activeEvaluatorRevisionId === revision.id ? (
                <span className="tag">Active</span>
              ) : (
                <button
                  className="button secondary"
                  disabled={pending}
                  onClick={() => void activate("evaluator", revision.id)}
                >
                  Activate evaluator
                </button>
              )}
            </div>
          ))}
        </section>
        <section className="bank-history-section">
          <h3>Jev profile revisions</h3>
          {detail.jevProfiles.length ? (
            detail.jevProfiles.map((profile) => (
              <div className="history-row" key={profile.id}>
                <div>
                  <strong>
                    {profile.name} - revision {profile.number}
                  </strong>
                  <p>{date(profile.createdAt)}</p>
                </div>
                {detail.bank.activeJevProfileRevisionId === profile.id ? (
                  <span className="tag">Active</span>
                ) : (
                  <button
                    className="button secondary"
                    disabled={pending}
                    onClick={() => void activate("jev", profile.id)}
                  >
                    Activate Jev profile
                  </button>
                )}
              </div>
            ))
          ) : (
            <p className="subtle">No published Jev profiles.</p>
          )}
        </section>
      </div>
    </Modal>
  );
}
