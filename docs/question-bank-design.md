# Question bank workspace

## Current workspace

Question banks contains three primary sections: Questions, Grading, and Findings.
History is a secondary action that opens published question, evaluator, and Jev profile revisions.
The same layout serves every bank.

Questions is the starting surface.
Its searchable list shows each reference answer, answer type, grading summary, and estimated answer size.
Filters identify tags and question-specific rules.
Selecting a question opens one focused editor rather than an all-question form.
The editor distinguishes public question context and answer instructions from the private reference answer.
It shows inherited rules and question-specific overrides together.
Resetting an override restores inheritance rather than copying the current default.
Trying an answer calls the actual deterministic evaluator without invoking a target or judge.

Grading starts with shared answer rules.
Specialized table rules, extraction, custom evaluator code, exclusions, and calibration remain available in advanced sections.
The controls show configured engine behavior and do not infer precision or ordering from question prose.
Written instructions do not silently become deterministic code.
Optional Jev instructions remain versioned and explicitly published separately from deterministic rules.
LLM judge model and instructions remain in Run setup.
This change does not introduce rubric-only questions or integrated AI authoring.

Findings presents reported concerns with links to their saved source answers.
Reports remain suggestions until a reviewer records a decision.
Reference corrections and exclusions retain their explicit publication actions.
Earlier runs and assessments keep their recorded revisions.

## Architecture and guarantees

React owns one workspace-scoped, bank-scoped authoring draft per browser tab.
Questions and deterministic settings share that draft.
Closing a focused editor discards its unsaved local changes.
Saving it updates the bank draft without publishing.
Navigation and reload preserve the bank draft.

Application operations validate and publish questions and deterministic rules in one transaction.
Publication checks the source question and evaluator revisions to prevent stale drafts from overwriting newer changes.
Calibration runs against the proposed questions before publication.
CLI and HTTP call the same operations.

Sample checks, calibration, and saved-answer previews use the existing evaluation module.
The browser never implements a second answer matcher.
Complete exports use a versioned package with questions and selected grading configuration.
Imports preview supported content and surface unsupported or invalid fields.

Published records and saved evidence remain immutable.
Target inputs contain only public question fields.
Provider credentials stay outside bank packages and drafts.
The workspace adds no execution hierarchy, storage framework, or provider orchestration.

## Implementation and publication flow

This page describes the inspected working tree on 2026-10-22.
The architecture audit records its revision and validation scope in the repository's audit ledger.

| Concern                          | Source owner                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Shared operation contracts       | [`commandSchemas`](../src/contracts.ts), dispatched by [`createApplication`](../src/application/application.ts). |
| Publication and exports          | [`CatalogService.publishBank`, `createBank`, `reviseBank`, and `exportPackage`](../src/application/catalog.ts).  |
| Reference and calibration checks | [`validateBankPolicies` and `calibrateSettings`](../src/application/calibration.ts).                             |
| Sample and saved-answer checks   | [`EvaluationService.checkAnswer`, `calibrateDraft`, and `previewDraft`](../src/application/evaluations.ts).      |
| Findings and reviewer decisions  | [`BankFindingService.report` and `resolve`](../src/application/bank-findings.ts).                                |
| Revision persistence             | [`Database.transaction` and record immutability policies](../src/storage/database.ts).                           |

For an existing bank, `banks.publish` requires the source question revision and active evaluator revision identifiers.
The catalog derives public answer formats and calibrates proposed questions against proposed deterministic settings before writing revisions.
Inside one transaction, it rechecks both identifiers, inserts the question and evaluator revisions, updates the bank, and appends the publication event.
A stale draft, invalid reference, or failed calibration leaves no partial publication.
An accepted finding correction uses the same transaction and rechecks that the finding remains open and unchanged.
[`bank-authoring.test.ts`](../src/application/bank-authoring.test.ts) covers these publication and competing-decision paths.

Standalone evaluator drafts remain supported through `evaluators.draft`, `evaluators.calibrate`, `evaluators.preview`, and `evaluators.publish`.
Their publication checks the latest question revision and unchanged draft after calibration.
Activation selects a published revision and does not change existing Run manifests.

Sample checks and draft calibration perform no catalog writes or provider calls.
Saved-answer previews verify evidence hashes and reject reference revisions that change the original question text or context.
Complete package exports validate that the selected evaluator and optional Jev profile belong to the same bank.
Jev profile publication remains separate from the question and deterministic-rule transaction.

See [reliable answer evaluation](evaluator-design.md) for comparison policies and [independent judges](judging.md) for Jev profiles and saved assessments.

## Review boundary

The implementation preserves existing advanced grading capabilities without requiring them in the main workflow.
Natural-language rule compilation, arbitrary new scoring semantics, and an autonomous authoring agent remain separate product decisions.
Rollback uses Git rather than retained legacy components.
