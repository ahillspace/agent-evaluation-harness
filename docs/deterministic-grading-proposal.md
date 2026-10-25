# Question-level custom evaluators

This proposal records an earlier design discussion.
Its existing-design descriptions are historical and do not define the current implementation.
See [evaluator design](evaluator-design.md) and [question-bank design](question-bank-design.md) for current behavior.

## Goal

Allow a bank author to add one pure custom evaluator to questions that need more than baseline comparison.

Keep the existing deterministic evaluator as the default for all other questions.

## Existing design

The evaluator already supports immutable revisions, per-question `questionOverrides`, decimal and typed comparison, exact scalar aliases, table column policies, previews, calibration, and rescoring of saved answers.

Per-question overrides already allow `mode: "custom"` with code, but the code receives only `{ expected, answer }` and returns a boolean verdict with an explanation.

Custom code runs in an isolated QuickJS runtime with 100 ms execution, 16 MB memory, a 512 KB stack, and bounded input and output sizes.

The browser currently exposes custom code as a global mode and exposes per-question overrides as advanced JSON.

Published bank and evaluator revisions are immutable, and a new assessment can score saved answers without rerunning a target.

The public `answerFormat` currently supports scalar, list, and typed table shapes.

It is validated when the target submits an answer and can also constrain evaluation, so it cannot represent every arbitrary JSON answer shape.

## Proposed contract

Extend the existing per-question custom path instead of creating a second evaluator pipeline.

Each question can have zero or one custom function in a published evaluator revision.

The function receives plain JSON containing the public question, private reference, captured answer value and text, and baseline result.

For example:

```json
{
  "question": {
    "id": "q1",
    "text": "Return the best matching record.",
    "context": "",
    "answerFormat": { "type": "json" }
  },
  "expected": { "id": 42, "name": "Example" },
  "answer": { "id": 42, "name": "Example LLC" },
  "answerText": "Example LLC, record 42",
  "baseline": {
    "status": "incorrect",
    "reason": "The submitted fields differ."
  }
}
```

The input contains no credentials, connection settings, provider traces, environment variables, paths, or process data.

Only completed attempts with sealed answers invoke the function.

Execution failures and missing answers remain visible as execution failures or unjudged results and are never sent to the function as ordinary wrong answers.

Preserve the existing `{ verdict, explanation?, details? }` result shape.

Boolean `true` and `false` keep their current meanings.

Keep the existing boolean result contract; do not add a third function outcome in this scope.

An exception, timeout, invalid return shape, or unsupported result becomes an assessment error, never an incorrect answer.

Custom results are author-defined criteria and do not independently prove semantic correctness.

Include the baseline verdict so a function can require both the baseline to pass and a custom condition to pass, or deliberately define different criteria for that question.

Do not automatically accept a missing answer, an invalid submission, or an execution failure.

## Answer shapes and public formats

Add a generic JSON answer format that an author can choose for a custom question that needs arbitrary JSON output.

It permits captured scalars, objects, nested arrays, and free text while retaining existing answer size limits and sealed-answer rules.

Typed scalar, list, and table formats remain available and retain their current validation behavior.

When the author selects generic JSON, a derived typed format must not be applied as an extra gate before custom evaluation.

The function can inspect both `answer` and `answerText`; it must not assume that one can always be reconstructed from the other.

Keep the existing `expected` and `answer` input fields and add question, text, and baseline context to the same contract.

## Authoring and scoring workflow

In the question detail's **Answer matching** controls, an author may keep baseline matching or add a custom function for that question.

The editor provides a bounded test panel using the question, private reference, and sample answer, and may preview the function on saved answers before publication.

Testing and preview are optional; shared engine regression tests are required for the function contract and sandbox guarantees.

Publishing creates an immutable evaluator revision containing the function source and its digest.

The run manifest and assessment pass identify the selected evaluator revision, which versions every per-question function and policy.

A configured custom score pass uses the custom function for configured questions and baseline scoring for every other question.

The original baseline pass remains unchanged and visible as a separate pass.

One evaluator revision produces one composite pass; it does not create a score column for every custom function.

No target rerun is needed to reassess previously saved answers.

The CLI and browser use the same evaluator contracts, publishing, preview, and saved-answer assessment operations.

Simple text alternatives can continue to use exact private aliases.

Human-approved judgments remain a separate assessment pass and are not implicit outputs of custom functions.

## Execution boundary

Use the existing QuickJS-backed evaluator and its resource limits as the initial JavaScript runtime.

Do not implement custom code with `eval`, Node's `vm`, or a new in-process execution path.

The evaluator function is synchronous and pure; the runtime exposes no filesystem, network, shell, process, MCP, or credential capabilities.

Keep time, memory, stack, input, and output bounds enforced for every invocation.

Do not require an installed Python runtime in the initial scope.

A future language can use a separate evaluator port if there is a concrete need.

## Acceptance criteria

Regression tests verify the existing pass and fail mapping and that missing answers remain outside custom evaluation.

Regression tests verify thrown errors, invalid return values, infinite loops, and resource-limit failures become assessment errors rather than incorrect answers.

Regression tests verify the custom input contains only public question fields, the private expected reference, sealed answer value and text, and the baseline result.

Regression tests verify generic JSON submissions accept scalar, nested object, array, and free-text values within existing size limits.

Regression tests verify ordinary typed formats and baseline evaluation remain unchanged for questions without a custom function.

Regression tests verify custom functions can compose with baseline correctness or apply explicitly authored alternative criteria.

Integration tests verify one custom configured pass combines custom and baseline question results, preserves the original pass, and creates no per-function score columns.

CLI and browser tests verify matching published revisions and preview outcomes.
