# Reliable answer evaluation

## Decision

Deterministic comparison remains the default.
Explicit policies describe acceptable equivalence; optional LLM and Jev judgments remain independent.
Reference defects receive review dispositions or corrected revisions, rather than automatic passing grades.
The CLI and browser use the same engine contracts.

## Implementation map

This page describes the inspected working tree on 2026-10-22.
The architecture audit records its revision and validation scope in the repository's audit ledger.

| Concern                       | Source owner and entry points                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Comparison contract           | [`evaluatorSettingsSchema`](../src/contracts.ts) defines shared settings, question overrides, and calibration examples.                                                                     |
| Public answer boundary        | [`prepareQuestions`](../src/application/catalog.ts) validates and derives formats; [`publicEvaluationGuidance`](../src/contracts/evaluation-guidance.ts) describes public acceptance rules. |
| Pure grading                  | [`grade`](../src/evaluation/scoring.ts) selects the answer, validates the reference, applies representation rules, and returns a verdict.                                                   |
| Typed tables and ranking      | [`gradeTypedAnswer` and `validateReference`](../src/evaluation/typed-answers.ts) own typed values, ordering, ranking pools, and policy applicability.                                       |
| Publication and calibration   | [`CatalogService.publishBank` and `publishDraft`](../src/application/catalog.ts) call [`calibrateSettings`](../src/application/calibration.ts) before transactional publication.            |
| Saved-answer grading          | [`EvaluationService.assess` and `preview`](../src/application/evaluations.ts) calculate judgments from sealed evidence and compatible reference revisions.                                  |
| Named assessments and retries | [`AssessmentPassService`](../src/application/assessment-passes.ts) freezes pass configuration; [`AnswerSources`](../src/application/answer-sources.ts) resolves physical evidence.          |

Transport operations enter through [`createApplication`](../src/application/application.ts), which validates inputs and dispatches to these services.
Change comparison behavior in the evaluation module and keep browser checks, calibration, previews, and saved-answer grading consistent.

## Evidence and failure families

The six-run campaign contains 120 question slots, 115 completed answers, and five execution failures.
The assistant source audit identifies 28 representation false negatives and ten question or reference defects across historical cohorts.
These counts describe the campaign, not the accuracy of the revised evaluator.
No assistant label represents a human review.

| Failure family                     | Plausible alternatives                         | Chosen treatment                                                                  |
| ---------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------- |
| Hidden column names                | Guess names; match by values; publish names    | Public structural formats and reviewed aliases.                                   |
| Equivalent containers              | Recursive extraction; declared paths           | Explicit JSON Pointer extraction and existing lossless table decoding.            |
| Scalar versus one-item list        | Accept every list; require one representation  | Public scalar formats and opt-in singleton unwrapping.                            |
| Display rounding                   | Global fuzzy tolerance; declared precision     | Exact decimal arithmetic with explicit decimal places and column rules.           |
| Equal ranking keys                 | Ignore all order; require original order       | Duplicate-preserving comparison within declared tied groups.                      |
| Top-k cutoff ties                  | Accept matching scores; enumerate alternatives | Require a declared complete reference pool and explicit ranking keys.             |
| Calendar dates versus timestamps   | Truncate all timestamps; exact strings         | Explicit calendar-date or instant semantics with strict parsing.                  |
| Full names versus separate fields  | Heuristic splitting; declared structure        | Publish required fields; use custom evaluation for explicit semantic composition. |
| Extra explanatory fields           | Ignore all extras; exact coverage              | Keep exact coverage; use an explicit extraction path for a selected answer.       |
| Unrequested reference fields       | Require hidden columns; infer intent           | Publish requirements and revise references that misstate the question.            |
| Incorrect reference scope          | Broaden matching; trust reference              | Correct the reference revision or mark it for review.                             |
| Incorrect reference joins          | Judge overrides; reference validation alone    | Require independent evidence, then correction or review.                          |
| Nullability inferred from examples | Mirror observed rows; admit null structure     | Derived formats permit nulls; value comparison still distinguishes null.          |
| Judge overtrusts references        | Replace deterministic score; majority voting   | Fallible-reference instructions, abstention, independent scores, and calibration. |

Execution errors and malformed submissions remain separate from good-answer false failures.
Correct reasoning does not repair an incorrect final submitted value.

## Research basis

Braintrust recommends field-specific comparison rules and distinguishes omissions, invented values, and ambiguous sources.
Its scorers support custom logic, versioning, and saved-example testing.
[Field evaluation guidance](https://www.braintrust.dev/articles/how-to-score-individual-fields-in-llm-document-extraction), [scorer documentation](https://www.braintrust.dev/docs/evaluate/write-scorers).

LangSmith calibrates evaluators against labeled examples and examines disagreement.
It recommends diverse positive and negative labels, then additional examples to reduce overfitting.
Saved experiments can receive additional evaluators without rerunning targets.
[Evaluator alignment](https://docs.langchain.com/langsmith/improve-judge-evaluator-feedback), [saved-experiment evaluation](https://docs.langchain.com/langsmith/evaluate-existing-experiment).

Promptfoo separates exact, structural, custom-code, and model-based assertions and supports explicit input transformations.
This supports declared normalization rather than implicit fuzzy matching.
[Assertions reference](https://www.promptfoo.dev/docs/configuration/expected-outputs/).

Inspect distinguishes incorrect model responses, scoring errors, and unscored results.
Unscored results retain explanations and remain outside metric denominators, with coverage reported separately.
[Scoring policy](https://inspect.aisi.org.uk/scoring-policy.html).

The Spider test-suite evaluator preserves duplicate multiplicity when comparing unordered query results.
Its ordering heuristic does not resolve an underspecified top-k reference.
[Primary evaluator source](https://raw.githubusercontent.com/taoyds/test-suite-sql-eval/master/exec_eval.py).

These sources support the design; they do not establish that automatic grading can detect every incorrect reference.

## Comparison rules

Settings belong to a published evaluator revision, with optional question overrides.
Unknown evaluator-setting fields fail schema validation.
Reference validation rejects invalid column rules, ranking pools, and several incompatible policies before publication.
Typed table representation, explicit sorting, and distinct-row comparison run in Auto mode.
Authoring validation rejects typed-table policies that the selected mode cannot apply, after question overrides resolve.
Explicit sorting requires Auto comparison with a typed table.
Ordering and collation must have an active consumer rather than being superseded by another policy.
Historical grading and export preserve published settings; new publication applies current authoring rules.
Historical reference envelopes can contain ignored `tolerance` or `allow_column_permutation` metadata.
The editor warns about these fields; move their intended rules into evaluator settings explicitly.
Existing reference metadata is not automatically translated into an active comparison policy.
Typed reference validation checks structure, values, declared columns, aliases, and applicable policies.
Reference syntax validation cannot prove that a source query answers the question.

Decimal comparison preserves numeric strings without binary floating-point conversion.
Decimal-place comparison rounds half boundaries away from zero and takes precedence over tolerance for that value.
Use column rules for mixed currency, identifiers, and counts.
Rounding never determines which source ranking values are tied.

Calendar-date comparison preserves the written date and intentionally ignores valid time components.
Instant comparison requires a known timezone offset and preserves fractional-second precision.
Neither policy infers locale-specific dates or repairs invalid calendar values.

An answer path selects one explicit location in the submitted JSON value.
Explicit singleton unwrapping removes one array layer only when exactly one item exists.
The default compatible representation policy also accepts a scalar carried by one row and one cell.
It accepts supported JSON-encoded table representations without searching prose or removing extra rows or cells.
The strict representation policy requires the declared public format after explicit extraction and singleton selection.
[`selectAnswer` and `scalarRepresentation`](../src/evaluation/answer-policy.ts) own these transformations.

Unordered comparison preserves duplicate counts by default.
An explicit `duplicateRows: "distinct"` table policy compares distinct normalized rows instead.
Ordered tables permit permutations only inside equal reference ranking groups.
Explicit `sortOrder` checks row membership independently of reference row order and then verifies the requested ascending or descending keys.
The optional `collation` policy selects locale-aware text sorting, numeric sorting, punctuation handling, and sensitivity.
Top-k comparison requires every higher-ranked row and accepts boundary members only from the complete pool.
The pool declaration is an author assertion; the engine cannot infer completeness from the supplied rows.
Missing hidden ranking keys require a richer reviewed reference or custom evaluator.

## Public requirements and private evidence

Targets receive public question text, context, and structural answer formats.
Typed tables expose column names and types; typed scalars expose their value type.
An empty-table reference exposes a generic list format, never a required empty result.
Null references do not expose a forced-null format.
Expected values, candidate-pool rows, result counts, and custom evaluator code remain private.
Frozen public evaluation guidance describes acceptance rules, including text normalization, numeric tolerances, column rules, ordering, and duplicate handling.
Public nullability does not turn null into an acceptable substitute for a known value.

## Configure policies

The following settings illustrate independent question overrides.
Replace question and column names with names from the bank.

```json
{
  "questionOverrides": {
    "amount": { "decimalPlaces": 2 },
    "dates": {
      "columnRules": { "hired_at": { "dateComparison": "calendar_date" } }
    },
    "wrapped": { "answerPath": "/data/rows" },
    "one_name": { "unwrapSingleton": true },
    "disputed": {
      "referenceDisposition": "needs_review",
      "referenceNote": "The source scope has not been verified."
    },
    "ranking": {
      "topK": {
        "count": 10,
        "orderBy": [{ "column": "total", "direction": "desc" }],
        "referenceComplete": true
      }
    }
  },
  "calibrationExamples": [
    {
      "id": "currency-accepted",
      "questionId": "amount",
      "answer": 12.34,
      "expectedStatus": "correct"
    },
    {
      "id": "currency-wrong-cent",
      "questionId": "amount",
      "answer": 12.35,
      "expectedStatus": "incorrect"
    }
  ]
}
```

The currency examples assume the amount reference rounds to 12.34.
The ranking reference contains the full typed table of eligible candidates, not only the original top ten.
Every requested column remains part of row comparison.

## Calibrate, publish, and rescore

Calibration evaluates known answers against expected verdicts without calling a target model.
Include both accepted equivalents and nearby wrong answers for each policy.
Calibration records the actual reference revision used.
Publication checks configured cases against the latest bank revision and rejects disagreements.
An empty calibration collection provides no evidence of evaluator accuracy.

The browser exposes these operations under deterministic grading and saved-answer rescoring.
The CLI accepts the same JSON payloads:

```sh
node dist/cli.js evaluators.calibrate --file calibration-request.json
node dist/cli.js evaluators.preview --file preview-request.json
node dist/cli.js evaluators.publish --file publish-request.json
node dist/cli.js runs.assess --file rescore-request.json
```

A corrected-reference rescore request contains:

```json
{
  "runId": "run_REPLACE",
  "name": "Corrected reference assessment",
  "source": "deterministic",
  "evaluatorRevisionId": "evaluator_REPLACE",
  "bankRevisionId": "bankrev_CORRECTED"
}
```

Omitting the bank revision preserves the run's frozen references.
Corrected references must belong to the same bank and preserve the evaluated questions' identity.
Rescoring saves a named assessment pass with reference provenance and leaves target evidence and original assessments unchanged.
An original LLM judge remains labeled as original when displayed beside a later deterministic rescore.

[`RunService.executeAttempt`](../src/application/runs.ts) seals the target response before deterministic or optional model judging.
[`EvaluationService.recover`](../src/application/evaluations.ts) restores missing deterministic assessments from completed evidence without invoking a target or judge.
An interrupted model assessment receives an explicit error or unavailable record instead of an automatic paid retry.
Applying retry answers uses [`RetryApplicationService.apply`](../src/application/retry-applications.ts) to create derived passes with physical attempt identifiers and evidence hashes.
The original result, attempt, manifest, and saved scores remain unchanged.

## Execution and comparison bounds

Typed tables support at most 100 columns and 10,000 rows, using the shared [`MAX_ANSWER_ITEMS`](../src/contracts/answer-limits.ts) limit.
Exact unordered matches use complete normalized row multisets before tolerance-dependent assignment.
[`rowsMatch`](../src/evaluation/row-matching.ts) retains duplicates and bounds assignment work to 1,000,000 search steps.
Typed table comparisons also bound cell checks; tolerance-dependent unordered JSON comparisons support at most 500 items.
Exceeding these bounds produces an evaluation error rather than an incorrect-answer verdict.

[`gradeCustom`](../src/evaluation/custom.ts) runs evaluator code in a fresh QuickJS runtime without host filesystem or network bindings.
It sets a 16 MiB memory limit, a 512 KiB stack limit, and a 100 ms interrupt deadline.
It also checks serialized input and output string lengths before accepting a result.
These string-length guards do not measure UTF-8 byte sizes, and the interrupt deadline does not establish whole-command latency.
Custom code returns a boolean verdict with optional explanation and details; exceptions become evaluation errors.

See [independent judges](judging.md) for provider requests, named passes, confidence, and recovery behavior.

## Interpret coverage and limitations

An explicit reference-review disposition produces an unscorable result with a reason.
Unscorable answers stay visible and outside scored accuracy.
Scored-answer counts, exclusions, execution failures, and unavailable evaluations remain distinct.
LLM abstention displays no verdict and does not become a deterministic pass or failure.

The evaluator does not automatically repair references, verify arbitrary joins, infer complete ranking pools, or resolve semantic identity from similar names.
Optional judges can disagree or abstain; their confidence does not prove correctness.
Repeated calibration against only known failures can overfit, so retain negative controls and independent examples.
