import { useState } from "react";
import type {
  BankDetail,
  ConnectionRecord,
  JevJudgeSelection,
  JevProfileRevision,
} from "../contracts.js";
import { JevProfileEditor } from "./jev-profile.js";
import { Field, Modal } from "./ui.js";

export function jevConfigurationIssues(
  value: JevJudgeSelection,
  connections: ConnectionRecord[],
  bank?: BankDetail,
  additionalProfiles: JevProfileRevision[] = [],
): { connection?: string; profile?: string } {
  const hasConnection = connections.some(
    (item) =>
      item.id === value.connectionId &&
      item.provider === "typesafe" &&
      item.hasCredentials,
  );
  const connection = hasConnection
    ? undefined
    : "Choose a saved Jev API connection with credentials before starting this run.";
  if (!bank) return { connection };

  const profileId =
    value.profileRevisionId ?? bank.bank.activeJevProfileRevisionId;
  const profiles = [
    ...bank.jevProfiles,
    ...additionalProfiles.filter((item) => item.bankId === bank.bank.id),
  ];
  const hasProfile = profiles.some(
    (item) => item.id === profileId && item.bankId === bank.bank.id,
  );
  const profile = hasProfile
    ? undefined
    : profiles.length
      ? "Select or publish a Jev judging profile for this question bank before starting the run."
      : "This question bank has no published Jev judging profile. Publish criteria for this bank before starting the run.";
  return { connection, profile };
}

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
  onPublished: (profile: JevProfileRevision) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<JevProfileRevision | null>(null);
  const issues = jevConfigurationIssues(
    value,
    connections,
    bank,
    saved ? [saved] : [],
  );
  const profiles = [
    ...(saved &&
    saved.bankId === bank?.bank.id &&
    !bank.jevProfiles.some((item) => item.id === saved.id)
      ? [saved]
      : []),
    ...(bank?.jevProfiles ?? []),
  ];
  return (
    <div className="stack">
      <div className="form-grid">
        <Field
          label="Jev API connection"
          required
          help="The saved API key provides access to Jev. Judging criteria are published separately for each question bank."
        >
          <select
            aria-label="Jev API connection"
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
      <Field
        label="Bank judging profile"
        required
        help="Choose published judging criteria for this question bank. A saved Jev API connection does not include these criteria."
      >
        <select
          aria-label="Bank judging profile"
          value={value.profileRevisionId ?? ""}
          onChange={(event) =>
            onChange({
              ...value,
              profileRevisionId: event.target.value || undefined,
            })
          }
        >
          <option value="">
            {bank?.bank.activeJevProfileRevisionId
              ? "Active profile for this bank at launch"
              : "No active profile for this bank"}
          </option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name} · revision {profile.number}
            </option>
          ))}
        </select>
      </Field>
      {issues.connection && (
        <p className="notice" role="status">
          {issues.connection}
        </p>
      )}
      {issues.profile && (
        <p className="notice" role="status">
          {issues.profile}
        </p>
      )}
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
        {issues.profile
          ? "Publish criteria for this bank"
          : "Edit instructions and criteria"}
      </button>
      <p className="subtle">
        Save judge credentials in{" "}
        <a href="#/settings/connections">Settings, Connections</a>. This run
        uses the saved connection selected above.
      </p>
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
              onPublished(profile);
              setEditing(false);
            }}
          />
        </Modal>
      )}
    </div>
  );
}
