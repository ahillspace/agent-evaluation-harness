# Build verification

This historical record covers earlier build checkpoints.
See [observation redesign validation](observation-redesign-validation.md) for the latest recorded delivery checks.

Verification took place on Windows on October 3, 2026, using Node.js 25.6.1 and the minimum supported Node.js 22.13.0.
The checks below distinguish live provider behavior from isolated regression tests.
The CI definition covers Node.js 22.13.0 and 24 on Windows, Linux, macOS 15 ARM64, and macOS 15 Intel, but remote CI has not been run.

The initial rebuild acceptance run passed 85 tests, with one test for non-Windows behavior correctly skipped on Windows.
The Jev extension subsequently passed 120 tests on both Node.js 25.6.1 and the minimum supported Node.js 22.13.0, with the same platform-specific skip.
The subsequent evaluator campaign passed 158 tests on both tested Node.js versions, with the same platform-specific skip.
Final campaign validation passes formatting, all 70 production module architecture checks, TypeScript checks, lint, and the production build.
Testing Node.js 22.12.0 exposed its SQLite flag requirement, so the documented minimum was corrected instead of adding environment-specific launch flags.

## macOS runtime architecture

The platform refactor separates native credential storage and process mechanics from shared connection and invocation workflows.
Architecture checks cover 93 production modules and enforce these internal runtime boundaries.
Windows regression tests pass on Node.js 25.6.1 and 22.13.0.
The minimum-version Windows run passes 225 tests, with 11 platform-specific skips.
The Node.js 22.13.0 Linux container run passes 219 tests, with 17 platform-specific skips.
Eight POSIX process tests cover normal completion, descendants, cancellation, initialization interruption, output and time bounds, engine IPC loss, stale identities, and frozen-watchdog recovery.
The compiled POSIX helpers also pass a separate Node.js 22.13.0 container smoke test without the TypeScript loader.
The native Windows credential fixture has a 30-second test budget for multiple independently bounded native utility calls.

The compiled Windows server serves its browser shell and responds through the CLI after migrating a copied legacy connection file to version 2.
This startup check uses a separate workspace and makes no live provider calls.
Existing workspace evidence is not changed.
Independent architectural review found no remaining critical defect after fixes for launch shutdown, watchdog initialization, and frozen-helper recovery races.

Native Mac Keychain, provider authentication, Tableau MCP, browser workflows, and end-to-end research and judging remain unverified.
The configured Mac CI jobs have not run in this environment.
POSIX checks on Linux do not establish Mac compatibility or hard descendant containment.
The release acceptance gate and remaining native checks are recorded in [macOS support](macos-support.md).

## Evaluator reliability followup

The October 4, 2026 UTC followup passes 205 tests on Node.js 25.6.1 and 22.13.0, with one expected platform-specific skip.
Formatting, all 77 production module architecture checks, TypeScript checks, lint, and the production build pass.
Independent review reproduced and closed integer-constraint bypasses, contradictory semantic-state acceptance, ignored comparison modes, and numeric submission-bound mismatches.
The design record documents 14 failure families, researched alternatives, and policy boundaries in [Evaluator reliability](evaluator-design.md).

Saved-evidence replay verifies all 115 answer hashes across six runs of the same 20 questions.
Applying explicit native-singleton and calendar-date policies increases passes from 74 to 80 against the same reviewed evaluator baseline.
All six changed verdicts match the existing source audit; no passing answers regress, and all 14 source-audited wrong submissions remain rejected.
Five execution failures remain outside grading.
This sample measures representation fixes on repeated questions, not general evaluator accuracy.
No reference values change, and no provider calls occur.
Serialized singleton strings, undisclosed wrappers, and semantically defective references remain unresolved by these representation policies.

The compiled HTTP service reproduces the same 80 passes across all 115 saved answers.
A separate six-question calibration bank exercises 12 positive, negative, and unscorable cases through HTTP, CLI, and Chrome.
All 12 agree with their labels, and publication rejects a deliberately mislabeled negative case.
Chrome checks cover advanced policy controls, calibration without saved target runs, reference selection, and rescore provenance.
A browser-created rescore preserves the original manifest, attempts, and original score set byte-for-byte as parsed JSON.
Browser error and warning logs are empty during these checks.
Seven real stdio MCP process tests cover submission correction and numeric boundaries without model calls.
LLM abstention uses the real runtime parser with a stubbed provider invocation; live provider judgment quality is not measured in this followup.

Detailed replay, HTTP, CLI, and browser verification records reside under `.aeh/evaluator-improvement/`.
The tested service runs on port 4389 against a consistent copy of the prior six-run workspace.
Original campaign records and active evaluator settings remain unchanged.

## Live acceptance checks

| Workflow                | Observed result                                                                                                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Question bank authoring | Created and published a bank through Chrome.                                                                                                                                                                            |
| Codex target            | A browser-launched run submitted the numeric answer 42, saved its activity and usage, and received a correct deterministic assessment.                                                                                  |
| Tableau connection      | Authenticated against Tableau and discovered all 24 available MCP tools.                                                                                                                                                |
| Tableau target          | A browser-launched target called `list-datasources`, submitted a boolean answer, and received a correct assessment.                                                                                                     |
| Pause and Resume        | Pause drained the active Tableau question; Resume completed the run without repeating its saved answer.                                                                                                                 |
| Halt and Cancel         | Halt preserved two completed answers and interrupted the third; Resume created one new attempt; Cancel interrupted that attempt and removed further control actions.                                                    |
| Process cleanup         | No durable process scopes remained after the live control checks.                                                                                                                                                       |
| Human review            | Saved an independent review through the browser without changing the deterministic score.                                                                                                                               |
| Evaluator revision      | Saved a tolerance draft, previewed it against a saved answer, and published a new active revision.                                                                                                                      |
| Rescoring               | Added a separate score set through the browser while retaining the original assessment.                                                                                                                                 |
| Reuse                   | Loaded a saved run into Setup with its question selection, model, prompt, settings, and connections.                                                                                                                    |
| Export                  | Downloaded a real agent JSON file from Chrome and inspected its frozen settings and credential placeholders.                                                                                                            |
| Comparison              | Compared saved runs and observed explicit warnings for incompatible question banks and evaluation bases.                                                                                                                |
| Research                | The compiled CLI launched a baseline and one candidate, with Luna as researcher and optional judge. Both runs completed correctly, both judges returned true, and two researcher turns preserved the same conversation. |

## Regression coverage

The automated suite covers command validation, CLI/HTTP parity, launch idempotency, immutable manifests and evidence, evaluator bounds, exact decimal comparisons, tied rankings, unordered matching, revision history, research limits, conversation continuity, explicit gold retrieval, startup cleanup, and process ownership.
Architecture checks enforce module dependency direction and reject imports from the prior repository.
Windows tests exercise Job Object descendant limits, cancellation, abrupt owner exit, process recovery, and encrypted credential storage.
Platform-independent protocol tests also run on Linux.

The evaluator campaign adds public answer-format validation, reviewed column aliases, lossless table normalization, and nullable publication defaults.
Tests keep private reference values out of target projections and preserve prior bank revisions during publication.
Submission tests reject malformed answers before recording and preserve the first recorded answer after later invalid calls.
OpenCode usage tests include cache and reasoning components, duplicate steps, inconsistent totals, and unknown usage.
CLI and HTTP checks accept a leading UTF-8 byte order mark in Windows-authored JSON while rejecting malformed JSON.
Browser checks confirm readable submitted tables, explicit connection waiting, and original LLM judge provenance when viewing a rescore.
Cross-revision comparisons display incompatible evaluation-basis warnings.
Results and comparisons show execution failures separately and use the scored-answer count as the explicit accuracy denominator.
The real evaluation campaign report records findings and limits.

## Verification limits

### Jev extension

Jev verification used local HTTP fixtures and isolated browser workspaces, with no external model calls.
No Astra model was used for test runs during this extension.
A successful live TypeSafe inference remains unverified because no API credential was supplied.

Chrome checks covered separate classification display, bank-level instruction editing and publication, saved-answer selection, assessment preview, publication, and exact request/provenance inspection.
The final browser check also closed and reopened an unpublished preview, recovered it, and published the same assessment.
These fixture workspaces are separate from the user's saved runs.

Regression checks cover complete event pagination beyond 5,000 events, HTTP/CLI idempotency, publication without new inference, unchanged deterministic scores, schema migration, frozen profiles, question override inheritance, contradictory checks, research budgets, and recovery without automatic billable retries.
HTTP fixtures cover credential redaction, malformed classifications, unknown usage after retry failures, cancellation, deadlines, bounded responses, capacity errors, and rejection of credential-bearing redirects.
The independent architecture review identified recovery and override inheritance defects, verified their corrections, and reported no remaining blocking finding.

### Earlier runtime checks

The initial OpenCode invocation received HTTP 403.
The subsequent campaign successfully ran real Tableau questions through OpenCode's Space Bunny free model without a provider API key.
Nine other discovered free models still returned HTTP 403 through the installed native OpenCode runtime.
Their exact upstream rejection cause remains unverified.
API-key provider success was not tested against paid endpoints without supplied keys.
Local authenticated Codex execution was tested successfully.

Automatic approval review blocked an additional forced-crash test against the running application, reporting only that the action was blocked by policy.
That action was not retried.
Automated abrupt-process-exit and recovery tests passed separately.
Automatic approval review also blocked restarting the idle server to load the final compiled backend.
The main server on port 4381 still uses the earlier backend build.
Browser verification against that main workspace remains blocked until its backend restarts.
The separate Jev browser fixtures exercised the final source and frontend without opening or modifying the main workspace.
Reloading the final frontend confirmed this mismatch with an `Unknown operation: runs.observe` response from the earlier backend.
Stop the existing Agent Evaluation Harness server on port 4381, run `npm start` from this repository, and reload Chrome before using the final build.
The evaluator campaign instead uses separate QA workspaces with consistent SQLite backups and hash-verified immutable artifacts.
Automatic approval also blocks stopping the task-created idle QA server after all six runs complete.
The delivery QA server therefore uses a new port, 4388, and a consistent snapshot in `.aeh/qa-campaign/delivery-workspace`.
The campaign tests real provider execution and the production interface without changing the main workspace.
Chrome verification on port 4388 confirms all six completed runs, explicit failure counts, scored-answer denominators, and comparison warnings, with no browser errors.
The delivery snapshot preserves 115 answer artifacts, and all 36 runtime build files match the final live evaluation cohort.

Token and cost budgets stop additional admissions after reported usage reaches a ceiling.
They cannot prevent an already active provider invocation from consuming more usage before it returns.
Strict local process containment currently requires Windows.

The original application repository and its stored records remain unchanged.
No commit, push, or external publication was performed.

## External HTTP targets

The October 4, 2026 HTTP extension and runtime adapter boundary are documented in `http-target-verification.md`.
That report records current regression counts, browser checks, review findings, and platform limitations.
