import { useState } from "react";
import type { AssessmentPassSummary } from "../contracts/assessment-passes.js";
import { command } from "./api.js";
import { ErrorNotice, Help } from "./ui.js";

export const assessmentLabels = {
  deterministic: "Answer rules",
  llm: "LLM judge",
  jev: "Jev",
  human: "Human review",
};

export function selectedAssessment<T extends AssessmentPassSummary>(
  passes: T[],
  selectedId?: string,
) {
  return passes.find((pass) => pass.id === selectedId) ?? passes[0];
}

function assessmentOptionLabels(passes: AssessmentPassSummary[]) {
  const nameCounts = new Map<string, number>();
  for (const pass of passes)
    nameCounts.set(pass.name, (nameCounts.get(pass.name) ?? 0) + 1);
  const labels = passes.map((pass) => {
    if (nameCounts.get(pass.name) === 1)
      return { id: pass.id, label: pass.name };
    const created = new Date(pass.createdAt);
    const timestamp = Number.isNaN(created.getTime())
      ? "Time not recorded"
      : created.toLocaleString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
        });
    return { id: pass.id, label: `${pass.name} (${timestamp})` };
  });
  const labelCounts = new Map<string, number>();
  for (const { label } of labels)
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  return new Map(
    labels.map(({ id, label }) => [
      id,
      labelCounts.get(label) === 1 ? label : `${label} [${id}]`,
    ]),
  );
}

export function AssessmentSelector({
  runId,
  passes,
  selectedId,
  onSaved,
  label = "Saved score",
}: {
  runId: string;
  passes: AssessmentPassSummary[];
  selectedId?: string;
  onSaved: (id: string) => void;
  label?: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const optionLabels = assessmentOptionLabels(passes);
  const selected = selectedAssessment(passes, selectedId);
  return (
    <div className="score-selector">
      {passes.length < 2 ? (
        <span>
          {selected?.name ?? "Awaiting assessment"}
          {selected && selected.status !== "completed"
            ? ` (${selected.status})`
            : ""}
        </span>
      ) : (
        <select
          aria-label={label}
          value={selected?.id ?? ""}
          disabled={pending}
          onChange={(event) => {
            const passId = event.target.value;
            setPending(true);
            setError(null);
            void command("runs.select-assessment", { runId, passId })
              .then(() => onSaved(passId))
              .catch(setError)
              .finally(() => setPending(false));
          }}
        >
          {passes.map((pass) => (
            <option key={pass.id} value={pass.id}>
              {optionLabels.get(pass.id)}
              {pass.status === "completed" ? "" : ` (${pass.status})`}
            </option>
          ))}
        </select>
      )}
      <ErrorNotice error={error} />
    </div>
  );
}

export function AssessmentScore({
  pass,
  detailed = false,
}: {
  pass?: AssessmentPassSummary;
  detailed?: boolean;
}) {
  if (!pass) return <span className="subtle">Awaiting results</span>;
  const { coverage } = pass;
  return (
    <div className="assessment-score">
      <strong>
        {pass.judgedAccuracy === null
          ? "Awaiting results"
          : `${(pass.judgedAccuracy * 100).toFixed(1)}%`}
      </strong>
      <small>{`${coverage.correct} / ${coverage.judged} correct`}</small>
      <small>{`${coverage.judged} / ${coverage.eligible} judged`}</small>
      {(coverage.unjudged > 0 || coverage.errors > 0) && (
        <small>{`${coverage.unjudged} unjudged · ${coverage.errors} assessment errors`}</small>
      )}
      {coverage.excluded > 0 && <small>{coverage.excluded} excluded</small>}
      {detailed && (
        <>
          <small>
            {coverage.answered} answered · {coverage.incorrect} incorrect ·{" "}
            {coverage.reviewed} reviewed
          </small>
          <small>
            Accuracy uses completed judgments
            <Help label="Score coverage">
              Accuracy is correct judgments divided by completed pass or fail
              judgments. Unanswered questions, missing judgments, and assessment
              errors do not count as incorrect answers. Coverage shows how many
              eligible questions have a judgment.
            </Help>
          </small>
        </>
      )}
    </div>
  );
}
