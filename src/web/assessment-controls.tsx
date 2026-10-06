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
  return (
    <div className="score-selector">
      <select
        aria-label={label}
        value={selectedAssessment(passes, selectedId)?.id ?? ""}
        disabled={pending || !passes.length}
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
        {!passes.length && <option value="">Awaiting assessment</option>}
        {passes.map((pass) => (
          <option key={pass.id} value={pass.id}>
            {pass.name}
            {pass.status === "completed" ? "" : ` (${pass.status})`}
          </option>
        ))}
      </select>
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

export function AssessmentScores({
  passes,
  selectedId,
}: {
  passes: AssessmentPassSummary[];
  selectedId?: string;
}) {
  if (!passes.length) return <p className="subtle">Awaiting results</p>;
  return (
    <section
      className="assessment-scores"
      aria-label="All assessment scores"
      tabIndex={0}
    >
      {passes.map((pass) => (
        <article
          key={pass.id}
          className={`assessment-score-card${pass.id === selectedId ? " selected" : ""}`}
          aria-label={pass.name}
        >
          <h2 title={pass.name}>
            {pass.name === "Original deterministic"
              ? "Deterministic"
              : pass.name === "Original LLM judge"
                ? "LLM judge"
                : pass.name === "Original Jev"
                  ? "Jev"
                  : pass.name}
          </h2>
          <AssessmentScore pass={pass} />
        </article>
      ))}
    </section>
  );
}
