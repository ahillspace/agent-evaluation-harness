import { sameDraftValue, type BankDraft } from "./bank-draft.js";
import { json } from "./ui.js";

export function BankPublicationReview({
  baseline,
  draft,
}: {
  baseline: BankDraft;
  draft: BankDraft;
}) {
  const previous = new Map(
    baseline.questions.map((question) => [question.id, question]),
  );
  const current = new Map(
    draft.questions.map((question) => [question.id, question]),
  );
  const ids = [...new Set([...previous.keys(), ...current.keys()])];
  const changed = ids.filter(
    (id) => !sameDraftValue(previous.get(id), current.get(id)),
  );
  const fields = {
    text: "Question",
    expected: "Private reference",
    context: "Public context",
    evaluationGuidance: "Public answer instructions",
    answerFormat: "Public answer format",
    tags: "Tags",
  } as const;
  return (
    <div className="stack bank-publication-review">
      {baseline.name !== draft.name && (
        <p>
          Bank name: <strong>{baseline.name || "New bank"}</strong> to{" "}
          <strong>{draft.name}</strong>.
        </p>
      )}
      <h3>Question changes ({changed.length})</h3>
      {changed.length ? (
        changed.map((id) => {
          const before = previous.get(id),
            after = current.get(id);
          const labels =
            before && after
              ? Object.entries(fields)
                  .filter(
                    ([field]) =>
                      !sameDraftValue(
                        before[field as keyof typeof fields],
                        after[field as keyof typeof fields],
                      ),
                  )
                  .map(([, label]) => label)
                  .join(", ")
              : after
                ? "Added question"
                : "Removed question";
          return (
            <details className="disclosure" key={id}>
              <summary>
                {id}: {labels}
              </summary>
              <div className="form-grid">
                <div>
                  <strong>Before</strong>
                  <pre className="json-view">
                    {before ? json(before) : "Not present"}
                  </pre>
                </div>
                <div>
                  <strong>Draft</strong>
                  <pre className="json-view">
                    {after ? json(after) : "Removed"}
                  </pre>
                </div>
              </div>
            </details>
          );
        })
      ) : (
        <p className="subtle">Questions stay the same.</p>
      )}
      <h3>Grading changes</h3>
      {baseline.evaluatorName !== draft.evaluatorName && (
        <p>
          Evaluator name: <strong>{baseline.evaluatorName}</strong> to{" "}
          <strong>{draft.evaluatorName}</strong>.
        </p>
      )}
      {!sameDraftValue(baseline.settings, draft.settings) ? (
        <details className="disclosure">
          <summary>Review exact rule changes</summary>
          <div className="form-grid">
            <div>
              <strong>Before</strong>
              <pre className="json-view">{json(baseline.settings)}</pre>
            </div>
            <div>
              <strong>Draft</strong>
              <pre className="json-view">{json(draft.settings)}</pre>
            </div>
          </div>
        </details>
      ) : (
        <p className="subtle">Grading rules stay the same.</p>
      )}
      {draft.importedJevProfile && (
        <p className="notice">
          Imported Jev profile criteria require separate publication after the
          bank is saved.
        </p>
      )}
    </div>
  );
}
