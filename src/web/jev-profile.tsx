import { useState } from "react";
import {
  jevProfileSettingsSchema,
  type JevProfileRevision,
  type JevProfileSettings,
} from "../contracts.js";
import { command } from "./api.js";
import { ErrorNotice, Field, Status, date } from "./ui.js";
import { answerOnlyJevSettings } from "../contracts/answer-only-judge.js";

const checkTitles = {
  answer: "Answer correctness",
  evidence: "Evidence support",
  reference: "Reference consistency",
} as const;

export function JevProfileEditor({
  bankId,
  profiles,
  activeId,
  onSaved,
}: {
  bankId: string;
  profiles: JevProfileRevision[];
  activeId?: string;
  onSaved: (profile: JevProfileRevision) => void;
}) {
  const active =
    profiles.find((profile) => profile.id === activeId) ?? profiles[0];
  const [name, setName] = useState(active?.name ?? "Jev judging criteria");
  const [settings, setSettings] = useState<JevProfileSettings>(
    () => active?.settings ?? answerOnlyJevSettings(),
  );
  const [overrides, setOverrides] = useState(
    JSON.stringify(settings.questionOverrides ?? {}, null, 2),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const publish = async () => {
    setPending(true);
    setError(null);
    try {
      onSaved(
        await command("jev.profiles.publish", {
          bankId,
          name,
          activate: true,
          settings: jevProfileSettingsSchema.parse({
            ...settings,
            questionOverrides: JSON.parse(overrides),
          }),
        }),
      );
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="panel-body stack">
      <div>
        <h3>Versioned Jev instructions and criteria</h3>
        <p className="subtle">
          Publishing creates a new bank profile. Saved runs and previous
          assessments keep their original version.
        </p>
      </div>
      <ErrorNotice error={error} />
      <Field label="Profile name">
        <input
          aria-label="Jev profile name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field
        label="Required evidence"
        help="Declare whether this profile evaluates returned answers or requires internal agent actions. External endpoints provide answer evidence only."
      >
        <select
          aria-label="Jev required evidence"
          value={settings.evidenceRequirement ?? "unspecified"}
          onChange={(event) =>
            setSettings({
              ...settings,
              evidenceRequirement: event.target.value as
                "answer" | "internal-activity" | "unspecified",
            })
          }
        >
          <option value="unspecified">Not declared</option>
          <option value="answer">Answer evidence</option>
          <option value="internal-activity">Internal agent activity</option>
        </select>
      </Field>
      <Field
        label="Shared judge instructions"
        help="These instructions apply to the three independent Jev checks. The target agent never receives judging criteria."
      >
        <textarea
          aria-label="Jev shared instructions"
          rows={4}
          value={settings.instructions}
          onChange={(event) =>
            setSettings({ ...settings, instructions: event.target.value })
          }
        />
      </Field>
      <Field
        label="Needs review confidence threshold"
        help="The application marks low-confidence classifications for review. This does not change deterministic scores."
      >
        <input
          aria-label="Jev confidence threshold"
          type="number"
          min="0"
          max="1"
          step="0.05"
          value={settings.confidenceThreshold}
          onChange={(event) =>
            setSettings({
              ...settings,
              confidenceThreshold: Number(event.target.value),
            })
          }
        />
      </Field>
      {(Object.keys(checkTitles) as Array<keyof typeof checkTitles>).map(
        (key) => (
          <details className="disclosure" key={key}>
            <summary>{checkTitles[key]} criteria</summary>
            <Field label="Check instructions">
              <textarea
                aria-label={`${checkTitles[key]} instructions`}
                rows={3}
                value={settings.checks[key].instructions}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    checks: {
                      ...settings.checks,
                      [key]: {
                        ...settings.checks[key],
                        instructions: event.target.value,
                      },
                    },
                  })
                }
              />
            </Field>
            {Object.entries(settings.checks[key].criteria).map(
              ([label, value]) => (
                <Field label={label.replaceAll("_", " ")} key={label}>
                  <textarea
                    aria-label={`${key} ${label} criterion`}
                    rows={2}
                    value={value}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        checks: {
                          ...settings.checks,
                          [key]: {
                            ...settings.checks[key],
                            criteria: {
                              ...settings.checks[key].criteria,
                              [label]: event.target.value,
                            },
                          },
                        },
                      })
                    }
                  />
                </Field>
              ),
            )}
          </details>
        ),
      )}
      <details className="disclosure">
        <summary>Question-specific criteria</summary>
        <p className="subtle">
          JSON keyed by question ID. Each entry can override shared instructions
          or check settings.
        </p>
        <textarea
          aria-label="Jev question overrides"
          className="code-input"
          rows={6}
          value={overrides}
          onChange={(event) => setOverrides(event.target.value)}
        />
      </details>
      <button
        className="button primary"
        disabled={pending || !name.trim()}
        onClick={() => {
          void publish();
        }}
      >
        {pending ? "Publishing..." : "Publish and activate profile"}
      </button>
      <details className="disclosure">
        <summary>Published profile versions ({profiles.length})</summary>
        {profiles.map((profile) => (
          <div className="history-row" key={profile.id}>
            <div>
              <strong>
                {profile.name} · revision {profile.number}
              </strong>
              <p>{date(profile.createdAt)}</p>
            </div>
            {profile.id === activeId ? (
              <Status value="active" />
            ) : (
              <button
                className="text-button"
                disabled={pending}
                onClick={() => {
                  setPending(true);
                  void command("jev.profiles.activate", {
                    bankId,
                    profileRevisionId: profile.id,
                  })
                    .then(() => onSaved(profile))
                    .catch(setError)
                    .finally(() => setPending(false));
                }}
              >
                Activate
              </button>
            )}
          </div>
        ))}
      </details>
    </div>
  );
}
