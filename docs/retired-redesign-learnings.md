# Old harness learnings and options

Use the existing `agent-evaluation-harness` as the product baseline.
Retire the rejected frontend in `tableau-mcp-autoresearch` and evaluate useful ideas individually.
This handoff records findings from the rejected build without treating them as proven defects in the retained harness.

## Preserve the baseline

The retained harness runs on port 4393.
The rejected preview runs on port 4320, with earlier previews on ports 4317 and 4318.
The repositories have separate architectures and histories.
Historical references to an old repository do not override these roles.

The retained repository contains substantial uncommitted work in bank authoring, grading, answer provenance, retries, and interface components.
Inventory that work and the running build before implementation.
Do not reset it, replace its components wholesale, or assume the served build includes every current source change.
Keep existing run data, source datasets, question banks, and operating-system credentials.

## Highest value next work

1. Establish the retained source and running-build baseline before making changes.
   Record which existing changes are implemented, validated, and served.
2. Complete one real supply-chain journey from JSON import through publication, run setup, observation, rescoring, and human review.
   Use an isolated workspace and the actual 65-question bank.
3. Make datasource selection readable while keeping exact execution identity and access scope inspectable.
   Show datasource names, preserve LUIDs, and distinguish prompt guidance from enforced datasource restrictions.
4. Reproduce the highest-impact correctness candidates below in the retained harness.
   Fix demonstrated problems in its application layer and shared contracts.
5. Evaluate mixed per-question scoring authority as a bounded addition to existing assessment passes.
   Preserve immutable evidence, reference identity, and explicit human decisions.
6. Investigate tool restriction and metadata prompts with controlled comparisons after correctness and workflow acceptance.

## Lessons that change the build process

- Design complete user journeys before placing individual features on screens.
  Each visible state needs a clear next action, including empty libraries, empty banks, missing connections, failed verification, and no search matches.
- Preserve useful capabilities through task-based composition.
  Moving controls into **Advanced** does not establish a coherent layout or explain prerequisite relationships.
- Treat shared component structure and styling as one contract.
  The rejected bank search bypassed input styles, and expanding filters vertically centered search beside a tall form.
- Give menus, disclosures, toolbars, and empty states defined behavior and layout.
  Nested native disclosures inside generic flex containers produced the scattered bank actions.
- Use one theme vocabulary across components.
  Undefined color variables in the rejected evaluator activated light fallbacks inside the dark interface.
- Model readiness around prerequisites and actionable recovery.
  A disabled evaluator query appeared as endless loading before a bank existed, and dependent blockers inflated the task count.
- Preserve user-facing metadata at the data boundary.
  Keeping only datasource IDs prevented the rejected Run screen from displaying meaningful names.
- Verify the integrated product after separate feature work.
  Functional code review and passing tests did not establish that bank screens were understandable or visually acceptable.
- Report functional checks, browser journeys, and visual acceptance separately.
  Screenshots saved during tests require review or comparison before they establish visual acceptance.
- Preserve real import and export journeys, including existing file formats.
  JSON package support in an engine did not make the rejected library capable of importing the supplied legacy JSON bank.

## Existing capabilities to retain

The retained source already contains focused bank questions, grading, findings, draft review, import preview, revision history, calibration, and atomic publication.
Existing assessment features include named saved-answer passes, human review, reference corrections, selective judgment retries, and immutable references.
Existing execution features include provider connections, external HTTP targets, setup persistence, blueprints, retries, and fixed research coverage.
Inventory their current source and served behavior before proposing replacements.

Relevant starting points include [bank design](question-bank-design.md), [configuration guidance](configuration-guide.md), and [assessment passes](../src/application/assessment-passes.ts).
The retained answer-source and retry-application work already addresses immutable physical attempts and explicit logical answer bindings.
Preserve that work when extending provenance or retry behavior.

## Correctness candidates worth checking

Every row needs reproduction in the retained harness before a fix is proposed.
These failures were confirmed in the rejected build; its successful regression tests do not validate the retained app.

| Priority | Candidate                                            | Retained-harness acceptance case                                                                    |
| -------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| High     | Metadata edits erase corrected expected answers.     | Change tags or category and verify that the grading override remains effective.                     |
| High     | Stale editors overwrite saved drafts.                | Save from two tabs and reject the stale submission while preserving its unsaved form.               |
| High     | Judgment retries lose answer provenance.             | Retry a failed judgment after raw-answer reprocessing and display the exact answer graded.          |
| High     | External research mutates ignored controls.          | Each permitted mutation changes the outgoing request or is unavailable before launch.               |
| High     | Reference coverage includes unselected questions.    | Rescore a selected subset using references that cover precisely that subset.                        |
| High     | Model-list entry removes newlines.                   | Enter two model IDs through normal keyboard input and preserve two separate choices.                |
| Medium   | Latest complete rescoring follows current selection. | Selecting Original or an older score does not change which complete rescore is latest.              |
| Medium   | Unsupported reasoning effort appears configurable.   | Every visible model control reaches the supported runtime contract.                                 |
| Medium   | Blank endpoints silently preserve overrides.         | Clear the endpoint, preserve authentication, and verify provider-default behavior.                  |
| Medium   | Comparison lists omit newly saved scores.            | Refresh saved choices after full or partial batch-rescore success.                                  |
| Medium   | Results pagination still loads complete history.     | Bound summary work and payloads before loading question-level evidence.                             |
| Medium   | Publication comparison scans question pairs.         | Compare large banks with indexed lookups and avoid recomputing unchanged differences during typing. |

The retained Results code already requests pages, and its publication review already builds a question map.
Those implementations require inspection and measurement rather than automatic replacement.

Two additional regression cases emerged during the rejected fixes.
Unicode search must use matching normalization for stored text and queries.
Exporting **Original automatic verdicts** must preserve automatic results, while explicit reviewed snapshots retain their human decisions.

## Mixed scoring option

The retained assessment-pass contract currently selects one source per pass: deterministic, LLM, Jev, or human.
The rejected engine supports a default authority with per-question overrides.
Selective transfer of those semantics could support exact numeric grading, semantic judging, and explicit human corrections within a clearly defined score.

Freeze the authority map, selected questions, reference revision, evaluator configuration, judge configuration, and answer provenance with the assessment.
Retain individual automatic assessments and human decisions so the final outcome remains explainable and reversible.
Define missing, unresolved, failed, excluded, and graded coverage explicitly.
Fit the design into the retained application operations and immutable assessment model.
Do not transplant the rejected engine or introduce its Study, Experiment, or Campaign hierarchy.

## Supply chain imports and reference integrity

The supplied bank uses the legacy JSON shape containing `name` and `questions`.
Its 65 questions include 37 integer, 12 decimal, 12 string, one table, and three unanswerable expected answers.
It contains 62 public answer-format declarations.
The retained [bank importer](../src/web/bank-import.ts) already supports legacy JSON and versioned packages.
Verify the exact file and preserve public context, answer instructions, typed answers, and grading settings.
Avoid a CSV round trip that loses fields.

The local acceptance fixtures are the supplied `question-bank.json` and `audit-source.hyper` files.
Keep their machine-specific locations outside repository documentation.

Existing source and golden-run audits in the retained `.aeh/audits/` directory identify ambiguity around cancellation policy and reference interpretation.
Resolve business definitions before changing expected answers to match an agent response.
The local extract does not establish equality with the current live datasource.
The rejected build's JSON-import fix remains unimplemented; its proposed regression tests are archived separately.

## Performance evidence and experiment options

The rejected Results audit used 30 runs with 1,000 questions each.
Its summary path returned 12,379,790 bytes and took about 3.54 seconds in that local measurement.
Its bank comparison loops took about 1.19 seconds at 10,000 questions and 4.41 seconds at 20,000 questions.
These measurements motivate bounded summaries and indexed comparisons; they do not measure retained-harness performance.

Historical supply-chain comparisons do not isolate tool restriction from prompt changes.
The compared 65-question banks changed guidance for every question and answer format for 12 questions.
The restricted configuration also added a datasource LUID to its prompt.
A separate six-question completed comparison reports only a 1.62 percent pooled duration reduction despite fewer tool calls.
That sample does not establish a general speed improvement.

For a controlled experiment, freeze the bank, references, datasource, model, limits, prompt, and scoring policy.
Vary tool availability and metadata guidance separately, repeat trials, and report coverage, correctness, median latency, tail latency, and token usage.
Use existing snapshots before authorizing new provider spending.
Saved evidence accompanies the recovery archive under `evidence/supplychain.json` and `evidence/primary-four-fixed-completed.json`.

## Options for the retained harness

| Option                                        | Value                                                                           | Boundary                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Recommended: incremental workflow improvement | Improves the actual bank-to-run journey while preserving existing capabilities. | Change one demonstrated problem at a time and inspect the integrated result.                        |
| Selective correctness or scoring transfer     | Adds a missing guarantee without retaining the rejected interface.              | Reproduce the need in the retained app and implement within its architecture.                       |
| Bounded performance investigation             | Tests whether restricted tools or metadata guidance improve useful outcomes.    | Preserve correctness and coverage, control confounders, and obtain authorization for provider runs. |

## Acceptance before another completion claim

- Exercise an empty workspace, an empty bank, the real JSON import, review, publication, setup, observation, rescoring, and human correction.
- Inspect populated, empty, loading, error, expanded, and filtered states at representative desktop and narrow widths.
- Use realistic datasource LUIDs, long names, large answers, and missing usage values in fixtures.
- Check alignment, readable theme colors, overflow, menu placement, stable layout, keyboard operation, and primary-action visibility.
- Keep screenshots or reviewed visual baselines available with the acceptance record.
- Confirm exports match their displayed assessment and preserve historical meaning.
- Run the retained harness checks appropriate to each change and report unverified live-provider behavior explicitly.

The rejected repository's 736 unit, six dataset, and 34 end-to-end test results belong only to that implementation.
No retained-harness code or behavior receives validation credit from those counts.
