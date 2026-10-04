import type { BankRevision, Question } from "../contracts.js";
import { Field } from "./ui.js";

export function ignoredReferencePolicies(
  questions: Question[],
): Array<{ questionId: string; fields: string[] }> {
  return questions.flatMap((question) => {
    const expected = question.expected;
    if (
      !expected ||
      typeof expected !== "object" ||
      Array.isArray(expected) ||
      typeof expected.type !== "string"
    )
      return [];
    const fields = ["tolerance", "allow_column_permutation"].filter((key) =>
      Object.hasOwn(expected, key),
    );
    return fields.length ? [{ questionId: question.id, fields }] : [];
  });
}

export function ReferencePolicyWarning({
  questions,
}: {
  questions: Question[];
}) {
  const warnings = ignoredReferencePolicies(questions);
  if (!warnings.length) return null;
  return (
    <div className="notice">
      <div>
        <strong>Reference metadata contains comparison rules</strong>
        <p>
          Comparison uses published evaluator settings. Move these rules into
          evaluator settings; reference metadata does not activate them.
        </p>
        <ul>
          {warnings.map((warning) => (
            <li key={warning.questionId}>
              {warning.questionId}: {warning.fields.join(", ")}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function selectedReferenceQuestion(input: {
  frozen?: Question;
  questionId?: string;
  referenceBankId?: string;
  revisions: BankRevision[];
}): Question | undefined {
  return input.referenceBankId
    ? input.revisions
        .find((revision) => revision.id === input.referenceBankId)
        ?.questions.find((question) => question.id === input.questionId)
    : input.frozen;
}

export function ReferenceSelector({
  revisions,
  value,
  onChange,
  frozen = true,
}: {
  revisions: BankRevision[];
  value: string;
  onChange: (value: string) => void;
  frozen?: boolean;
}) {
  return (
    <Field
      label="Reference answers"
      help="A revised reference changes only the grading basis. Saved target answers, prompts, and original assessments stay unchanged. Choose a corrected bank revision explicitly."
    >
      <select
        aria-label="Reference answers"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">
          {frozen ? "Frozen references from each run" : "Latest bank revision"}
        </option>
        {revisions.map((revision) => (
          <option key={revision.id} value={revision.id}>
            {revision.name} - revision {revision.number}
          </option>
        ))}
      </select>
    </Field>
  );
}
