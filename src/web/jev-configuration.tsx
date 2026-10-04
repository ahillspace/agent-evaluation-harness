import { useState } from "react";
import type {
  BankDetail,
  ConnectionRecord,
  JevJudgeSelection,
  JevProfileRevision,
} from "../contracts.js";
import { JevProfileEditor } from "./jev-profile.js";
import { Field, Modal } from "./ui.js";

export function JevConfiguration({
  value,
  onChange,
  connections,
  bank,
  onPublished,
}: {
  value: JevJudgeSelection;
  onChange: (value: JevJudgeSelection) => void;
  connections: ConnectionRecord[];
  bank?: BankDetail;
  onPublished: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<JevProfileRevision | null>(null);
  const profiles = [
    ...(saved && !bank?.jevProfiles.some((item) => item.id === saved.id)
      ? [saved]
      : []),
    ...(bank?.jevProfiles ?? []),
  ];
  return (
    <div className="stack">
      <div className="form-grid">
        <Field label="Jev connection" required>
          <select
            aria-label="Jev connection"
            value={value.connectionId}
            onChange={(event) =>
              onChange({ ...value, connectionId: event.target.value })
            }
          >
            <option value="">Choose a TypeSafe API key</option>
            {connections
              .filter((item) => item.provider === "typesafe")
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
          </select>
        </Field>
        <Field
          label="Jev model version"
          help="Use a pinned version so every assessment records a reproducible model selection."
        >
          <input
            aria-label="Jev model version"
            value={value.model}
            onChange={(event) =>
              onChange({ ...value, model: event.target.value })
            }
            placeholder="jev-1.13.0"
          />
        </Field>
      </div>
      <Field label="Jev criteria profile">
        <select
          aria-label="Jev criteria profile"
          value={value.profileRevisionId ?? ""}
          onChange={(event) =>
            onChange({
              ...value,
              profileRevisionId: event.target.value || undefined,
            })
          }
        >
          <option value="">Active bank profile at launch</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name} · revision {profile.number}
            </option>
          ))}
        </select>
      </Field>
      <p className="subtle">
        Three independent classifications assess the answer, supporting
        evidence, and reference consistency. Results remain separate from
        deterministic grading and the LLM judge.
      </p>
      <button
        className="button secondary"
        disabled={!bank}
        onClick={() => setEditing(true)}
      >
        Edit instructions and criteria
      </button>
      {!connections.some((item) => item.provider === "typesafe") && (
        <p className="warning">
          Add a TypeSafe / Jev connection in <a href="#/settings">Settings</a>.
        </p>
      )}
      {editing && bank && (
        <Modal
          title="Jev instructions and criteria"
          onClose={() => setEditing(false)}
        >
          <JevProfileEditor
            bankId={bank.bank.id}
            profiles={profiles}
            activeId={
              value.profileRevisionId ?? bank.bank.activeJevProfileRevisionId
            }
            onSaved={(profile) => {
              setSaved(profile);
              onChange({ ...value, profileRevisionId: profile.id });
              onPublished();
              setEditing(false);
            }}
          />
        </Modal>
      )}
    </div>
  );
}
