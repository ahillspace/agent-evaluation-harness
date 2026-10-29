# Architecture audit

The original audit below records the October 22, 2026 working tree.
The [implementation follow-up](#implementation-follow-up) records the authorized October 23 fixes and their separate validation.

## Baseline and scope

This audit examines the **agent-evaluation-harness** working tree on October 22, 2026.
The branch is **review/evaluation-reliability-2026-10-09**, based on commit **faddf6bba0cd01f822c44a35ba652eabc9ae99c8**.
The tree already contained substantial modified and untracked application, web, runtime, storage, test, and documentation work, including a deleted bank-evaluator component.
Claims below describe that working tree rather than the committed revision alone.
Relative source links and symbols identify the examined implementation.

Scope includes production source, tests, contracts, maintained scripts, CI, package/build definitions, documentation, and root agent instructions.
The retired repository is reference-only and is not a dependency.
Ignored dependencies, generated output, workspace records, secrets, and historical run artifacts were excluded from implementation coverage.
No installer, release publisher, repository-local plugin, or skill package was found.
The manifest marks the package private.

The audit updates documentation and records source changes as recommendations.
It does not implement the findings, alter dependencies or generated files, or change saved workspace data.
Windows with Node.js 25.6.1 is the local execution environment.
Source/test inspection is distinguished from executed fixtures and authenticated provider acceptance.

## Architecture assessment

The current boundaries fit a local evaluation product: one application engine, shared web/CLI contracts, runtime-owned integrations, and sealed evidence.
A second engine, generic workflow framework, or new execution hierarchy would add ownership without resolving the observed defects.
The strongest simplifications are to centralize logical comparison projections, make process acquisition match invocation ownership, and freeze credential identity with endpoint identity.
These changes remove divergent decisions rather than adding UI controls or compatibility wrappers.

[Architecture](architecture.md) owns the component map, state, operation traces, and change placement.
[Configuration guidance](configuration-guide.md) owns user operation; [CLI](cli.md) owns automation.
[Question-bank design](question-bank-design.md), [evaluator design](evaluator-design.md), and [judging](judging.md) own authoring and assessment behavior.
[Runtime](runtime.md), [target adapters](target-adapters.md), [HTTP targets](http-targets.md), and [platform support](macos-support.md) own integration details.
Historical delivery records describe their own checkpoints and do not certify the current dirty tree.

## Coverage ledger

“Source verified” means implementations and consumers were traced, with relevant tests inspected.
It does not mean those tests or external integrations ran during this audit.
Rows marked partial retain the stated operational limits.

| Area and responsibility                | Entrypoints, dependencies, and examined paths                                                                                                                                     | Evidence                                                                                                                                                                                                                                                                 | Status and canonical owner                                                                         | Limits                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Composition and ownership              | Server composes runtime/application; startup recovery, command admission, shutdown drain and failure cleanup                                                                      | [createApplication/dispatch/close](../src/application/application.ts), [application fixtures](../src/application/application.test.ts)                                                                                                                                    | Source verified; [architecture](architecture.md)                                                   | No new full-suite execution.                                                              |
| Shared transport and trust             | React/CLI -> HTTP -> schemas -> application; discovery, errors, denied Host/Origin and loopback binding                                                                           | [runCli](../src/cli.ts), [startServer](../src/server.ts), [web API](../src/web/api.ts), [transport tests](../tests/acceptance/transport.test.ts)                                                                                                                         | Source verified; IPv6 fixture reproduced; [CLI](cli.md), [configuration](configuration-guide.md)   | No adversarial security audit or browser acceptance.                                      |
| Bank publication and findings          | Draft/import -> formats/references -> calibration -> revision guards -> transaction; invalid formats, stale edits, concurrent decisions                                           | [CatalogService](../src/application/catalog.ts), [calibration](../src/application/calibration.ts), [BankFindingService](../src/application/bank-findings.ts), [authoring tests](../src/application/bank-authoring.test.ts)                                               | Source verified; policy fixture reproduced; [bank design](question-bank-design.md)                 | External reference truth cannot be established locally.                                   |
| Setup and launch identity              | Stored request -> shared launch -> frozen manifest; uncertain response, replay, reset, unavailable dependency/storage                                                             | [Setup](../src/web/setup.tsx), [draft schemas](../src/web/setup-draft.ts), [research launch tests](../src/application/research-launch.test.ts)                                                                                                                           | Source verified; [configuration](configuration-guide.md)                                           | No browser/provider launch acceptance.                                                    |
| Run lifecycle and sealing              | launch/control/drive/recover -> runtime -> events/artifact/hash -> assessments; Pause/Halt/Cancel, resume, fatal configuration, uncertain external completion                     | [RunService](../src/application/runs.ts), [lifecycle](../src/domain/lifecycle.ts), [TargetInvocations](../src/application/target-invocations.ts)                                                                                                                         | Source verified; [architecture](architecture.md), [runtime](runtime.md)                            | Concrete process paths covered separately below.                                          |
| Retry provenance                       | failed-slot guards -> linked Run -> sealed binding -> derived assessments -> idempotent transaction; wrong Run, replacement, conflict/replay                                      | [RunRetries](../src/application/run-retries.ts), [RetryApplicationService](../src/application/retry-applications.ts), [AnswerSources](../src/application/answer-sources.ts), [retry tests](../src/application/retry-applications.test.ts)                                | Source verified; [architecture](architecture.md)                                                   | Application alone does not establish provider behavior.                                   |
| Deterministic evaluation               | shared numeric/temporal formats -> policies/aliases/table matching/QuickJS; invalid, unscorable, incorrect, error, hash failure, preview/rescore                                  | [scoring](../src/evaluation/scoring.ts), [typed answers](../src/evaluation/typed-answers.ts), [custom evaluator](../src/evaluation/custom.ts), [EvaluationService](../src/application/evaluations.ts)                                                                    | Source verified; policy fixture reproduced; [evaluator design](evaluator-design.md)                | CPU bounds inspected; no performance benchmark.                                           |
| Judges and human review                | sealed evidence -> frozen request checkpoint -> runtime -> saved pass; abstain/error, failure usage, recovery, retry, inherited review/provenance                                 | [judge evidence](../src/application/judge-evidence.ts), [LlmJudgeService](../src/application/llm-judge.ts), [JevService](../src/application/jev.ts), [AssessmentPassService](../src/application/assessment-passes.ts)                                                    | Source verified; [judging](judging.md)                                                             | No live classifier/judge or fresh provider-contract certification.                        |
| Research continuity and budget         | baseline -> checkpointed exact conversation -> audited evidence -> bounded mutations -> ordinary candidates; continuity loss, unknown usage, admission denial, recovery/promotion | [ResearchService](../src/application/research.ts), [research budget](../src/application/research-budget.ts), [launch tests](../src/application/research-launch.test.ts)                                                                                                  | Partial; event truncation reproduced; [architecture](architecture.md)                              | Evidence-tail defect; no actual researcher session.                                       |
| Storage, queries, and usage            | local lock/WAL -> v1-v7 transaction/migration -> indexed projections/events; rollback, immutable bytes, Unicode filtering, pending/unknown usage                                  | [Database](../src/storage/database.ts), [owner lock](../src/storage/owner-lock.ts), [migration tests](../src/storage/database.test.ts), [performance](../src/application/performance.ts)                                                                                 | Source verified; [architecture](architecture.md)                                                   | No large-workspace or crash-injection benchmark.                                          |
| Web observation/results                | summaries + event cursors, query cancellation, selected passes, compatibility warnings, applied answers, review/export                                                            | [Observe](../src/web/observe.tsx), [Results](../src/web/results.tsx), [assessment dialog](../src/web/assessment-dialog.tsx), [run tools](../src/web/run-tools.tsx)                                                                                                       | Source verified; comparison HTTP fixture reproduced; [configuration](configuration-guide.md)       | Pixel layout and interactive browser acceptance unverified.                               |
| Settings and resources                 | route-driven sections -> connection/model discovery -> paginated datasource selection; stale request isolation and errors                                                         | [Settings](../src/web/settings.tsx), [connection resources](../src/web/connection-resources.tsx), [runtime](../src/runtime/index.ts)                                                                                                                                     | Source verified; [configuration](configuration-guide.md), [runtime](runtime.md)                    | Live entitlements/resources unverified.                                                   |
| Runtime registration/providers         | LocalRuntime -> platform services/registry -> managed or HTTP adapter; lazy native readiness, provider submission/usage/continuity and partial failures                           | [runtime composition](../src/runtime/index.ts), [harness](../src/runtime/harness.ts), [Claude](../src/runtime/claude.ts), [Bedrock](../src/runtime/bedrock.ts), [discovery](../src/runtime/discovery.ts)                                                                 | Partial; [runtime](runtime.md)                                                                     | Installed CLI/authenticated compatibility unverified.                                     |
| Process capacity and cleanup           | target admission -> supervisor -> native scopes; deadline, cancellation, recovery, identity denial and admission closure                                                          | [registry](../src/runtime/targets/registry.ts), [ProcessSupervisor](../src/runtime/process-supervisor.ts), [Windows](../src/runtime/processes/windows.ts), [POSIX](../src/runtime/processes/posix.ts)                                                                    | Partial; real Windows Bedrock bridge fixture; [runtime](runtime.md), [platforms](macos-support.md) | No native Mac execution; low-capacity fixture is not full Run/UI acceptance.              |
| Connections and secrets                | save/freeze/materialize -> storage/secret scope -> DPAPI or Keychain; replacement, migration, cleanup, copied-workspace denial                                                    | [ConnectionService](../src/runtime/connections.ts), [connection storage](../src/runtime/connection-storage.ts), [secret scope](../src/runtime/secrets/scope.ts), [platform](../src/runtime/platform.ts)                                                                  | Source verified; [runtime](runtime.md)                                                             | No real credentials or interactive Keychain; credential finding remains.                  |
| HTTP target protocol                   | public config -> scoped credentials -> bounded request/response mapping -> recovery checkpoints; rejection, timeout, uncertainty, historical credential retention                 | [HTTP adapter](../src/runtime/targets/http-adapter.ts), [transport](../src/runtime/targets/http.ts), [catalog](../src/runtime/targets/catalog.ts), [acceptance](../tests/acceptance/http-target.test.ts)                                                                 | Source verified; [HTTP targets](http-targets.md), [external targets](external-targets.md)          | No live endpoint acceptance.                                                              |
| Tableau and independent provider calls | REST/MCP sessions/resources and feature gate; judge/research bridges; Jev bounds/retry/fallback/shutdown                                                                          | [Tableau connection](../src/runtime/tableau-connection.ts), [MCP resources](../src/runtime/mcp-resources.ts), [feature gate](../src/runtime/tableau-feature-gate.ts), [Jev HTTP](../src/runtime/jev-http.ts), [LocalRuntime.judge](../src/runtime/index.ts)              | Partial; [runtime](runtime.md), [judging](judging.md)                                              | Authenticated compatibility, pricing/capacity, and service versions not freshly verified. |
| Delivery and ancillary tooling         | package/TypeScript/Vite -> generated server/assets; CI matrix; AST architecture checker and offline seeder                                                                        | [manifest](../package.json), [build config](../tsconfig.build.json), [Vite](../vite.config.ts), [current local gate](architecture.md#build-tooling-and-change-placement), [checker](../scripts/architecture-check.mjs), [seeder](../scripts/seed-observation-preview.ts) | Source verified; seeder type check fails; [architecture](architecture.md), [AGENTS](../AGENTS.md)  | CI configuration is not execution; no installer/release system to assess.                 |

## Findings

### A1. Bedrock bridge acquisition can deadlock and poison admission

**Priority: high. Confidence: high for the reproduced low-capacity path.**
**invokeBedrock** in [bedrock.ts](../src/runtime/bedrock.ts) creates persistent **McpSession** bridges sequentially and holds earlier process reservations while requesting later ones.
**createHarnessBridges** adds a submission bridge after connection bridges.
[ProcessSupervisor.acquire](../src/runtime/process-supervisor.ts) limits each process scope independently of [TargetRegistry.admit](../src/runtime/targets/registry.ts).

A local fixture with supervisor capacity 1 and a connection bridge timed out before acquiring its submission bridge.
A fetch guard observed zero network calls.
The result was **cleanup_failed** although supervisor reservations returned to zero: **McpSession.close** propagated cancellation of a queued invocation, and Bedrock treated the rejected close as unresolved cleanup.
The registry then blocks later target admission.
Parallel exhaustion at default capacity follows the same structure but was not reproduced.

Admit the complete invocation's bridge requirement atomically, or give its bridges one owned invocation scope.
Distinguish cancellation before launch from genuinely unresolved cleanup.
This removes nested hold-and-wait while retaining deadlines, process limits, answer evidence, cancellation, and admission closure for real leaks.
Verify through application-level low-capacity and parallel Bedrock fixtures, including recovery of capacity.
Evidence that product configuration prevents these combinations could disprove reachability; the current runtime permits them.
The reproduction exercised real Windows process supervision directly, not authenticated Tableau or the full Run/UI path.

### A2. Research evidence silently truncates the event tail

**Priority: high. Confidence: high.**
[ResearchService.evidence](../src/application/research.ts) calls **Database.events** with a Run identifier and then filters the returned first page by attempt.
[Database.events](../src/storage/database.ts) defaults to 5,000 events.
Late tool evidence disappears, and unrelated Run events consume the same page.

A provider-free application launch with a 5,005-event target trace returned 4,998 researcher-visible events; the final marker was absent.
Scope retrieval by physical attempt and drain cursor pages, or define an explicit bounded continuation contract.
Remove repeated whole-Run scans while preserving session authorization, judge/evaluation-event filtering, and audited gold access.
Verify more than 5,000 events across multiple attempts with gold access both denied and allowed.
A documented enforced trace cap or complete continuation exposed to the researcher would disprove silent truncation; neither was found.

### A3. Frozen managed endpoints resolve mutable credentials

**Priority: high. Confidence: high from source tracing.**
[ConnectionService.freeze](../src/runtime/connections.ts) stores public settings and a connection identifier.
**materialize** resolves **credentials(binding.connectionId)** from the current connection record.
**save** permits changing endpoint settings and the secret together.
Invocation can therefore combine an old frozen endpoint with today's replacement secret.

Resume or reuse can change credential identity without changing the frozen manifest.
A replacement credential could be sent to a historical endpoint after endpoint and credential rotation.
This was traced through model and Tableau environment materialization; no real credentials or remote endpoint were exercised.

Use identity-bound versioned secret references for new managed snapshots, following the existing [external catalog](../src/runtime/targets/catalog.ts) ownership pattern.
Remove invocation-time dependence on mutable catalog credentials, with an explicit legacy decoder.
Preserve redaction, copied-workspace denial, crash-safe replacement, immutable evidence, and explicit credential rebinding.
Verify local endpoint A/key A, rotate to endpoint B/key B, then materialize both snapshots and assert key B never reaches endpoint A.
Deliberate mutable credentials could explain rotation policy but do not resolve the endpoint trust mismatch.

### A4. Comparison reports original failures after successful retry application

**Priority: medium. Confidence: high.**
[EvaluationService.compare](../src/application/evaluations.ts) counts physical result statuses.
The **runs.compare** dispatcher in [application.ts](../src/application/application.ts) replaces assessment metrics but leaves physical completed/failed counts.
[Results comparison](../src/web/results.tsx) renders those counts as Run outcomes.
[RunService.view](../src/application/runs.ts) instead uses the logical answer projection.

A provider-free HTTP fixture failed an original Run, succeeded on a linked retry, and applied the retry.
**runs.get** then reported completed 1/failed 0 while **runs.compare** reported completed 0/failed 1 for the same original Run.
Give comparison one application owner using **AnswerSources** plus selected assessment provenance.
This removes the split projection and dispatcher patching.
Keep physical failures as explicitly named historical metrics, preserve immutable evidence, and retain compatibility warnings.
Verify partial applications, historical passes, and untouched failures through HTTP and component fixtures.
An explicit original-outcome comparison contract with distinct UI labels would change the finding; current presentation does not make that distinction.

### A5. Table policy validation accepts settings the selected grader cannot apply

**Priority: medium. Confidence: high.**
[validateReference](../src/evaluation/typed-answers.ts) validates sorting columns and conflicts without requiring Auto mode.
Sorting is applied through **gradeTypedAnswer/compareTables**, while [scoring](../src/evaluation/scoring.ts) dispatches JSON mode elsewhere.

A public application fixture accepted a typed integer table with JSON mode, unordered arrays, and ascending **sortOrder**.
Checking correctly ascending public rows returned incorrect.
A direct grader fixture also showed reversed typed envelopes passing JSON equality while the sorting policy was ignored.

Validate policy applicability before publication rather than adding alternate grading fallbacks.
Reject sorting outside Auto mode and audit the applicability of duplicate-row and collation policies.
Preserve deliberate JSON/custom semantics and existing immutable revisions.
Verify negative publication/calibration cases and positive ascending/descending public answer cases.
A shared grader applying these policies consistently across accepted modes would disprove the gap; current dispatch does not.

### A6. Maintained preview tooling has a stale contract outside the gate

**Priority: medium. Confidence: high.**
The judge fixture in [seed-observation-preview.ts](../scripts/seed-observation-preview.ts) reads **input.question.id**, while **RuntimePort.judge** receives **input.evidence.question**.
[tsconfig.json](../tsconfig.json) excludes scripts, so normal validation misses it.
An explicit strict NodeNext type check failed with two TS2339 errors at the stale accesses.
The seeder itself was not run because it writes a preview workspace.

Update the seeder to the shared judge-evidence contract and include maintained scripts in type checking or a focused tooling project.
This removes an ungoverned ancillary boundary rather than adding a compatibility helper.
Keep it offline, fixture-based, and isolated from ordinary workspaces.
Verify both script compilation and an isolated preview-seeding workflow.
An explicit declaration that the script is abandoned would change its maintenance status; it remains a named usable workflow.

### A7. Model discovery lacks a bounded body reader

**Priority: medium. Confidence: high for missing bounds.**
[LocalRuntime.probeConnection](../src/runtime/index.ts) uses **response.json()** after a fetch deadline without a response-byte ceiling.
Other integrations use bounded body readers.
A configured gateway can cause disproportionate memory use.
Catalog completeness is also uncertain because this path does not paginate, though provider pagination requirements were not externally certified.

Use bounded catalog parsing and provider-specific pagination where required.
Preserve no-inference discovery, cancellation, and sanitized authentication errors.
Verify oversized, malformed, slow, and paginated local fixtures.
A lower transport layer enforcing the byte limit would disprove the bounds finding; none was found.
No oversized remote response was requested during the audit.

### A8. Supported IPv6 binding returns an invalid server URL

**Priority: low. Confidence: high.**
[startServer](../src/server.ts) accepts **::1** but assembles an unbracketed URL.
A local fixture bound successfully while **new URL(server.url)** failed.
Bracket IPv6 hosts during URL construction.
Preserve loopback restrictions and IPv4/localhost behavior.
Verify URL parsing, discovery fetch, and **runCli** against **::1**.
The CLI already accepts bracketed IPv6 endpoints; no separate execution engine is needed.

## Documentation reconciliation

Current runtime and external-target pages now describe implemented adapters rather than deferred plans.
Architecture responsibilities and source links replace accumulated implementation notes.
Question-bank documentation describes current publication rather than completed build steps.
Public evaluation requirements are distinguished from private expected values.
README and agent instructions point to canonical owners instead of duplicating their contracts.
Historical verification and evaluator proposals are labeled as historical context rather than current implementation truth.

## Validation and limitations

Focused fixtures reproduced A1, A2, A4, A5, and A8 without provider calls.
Temporary fixture workspaces were removed.
A3 and A7 are source-backed findings without remote reproductions.
A6 is a reproduced ancillary type-check failure, not a completed seeder execution.
Previously recorded delivery test totals are not results of this audit.

| Check                                                           | Result                                                                                                           |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Focused local reproductions                                     | A1, A2, A4, A5, and A8 reproduced; no provider calls.                                                            |
| Preview script type check                                       | Failed with two TS2339 errors, recorded as A6; no seeder execution.                                              |
| `npm run check:architecture`                                    | Passed for 164 production modules.                                                                               |
| Prettier check of the 17 edited documentation/instruction files | Passed.                                                                                                          |
| Local Markdown navigation scan                                  | Passed: 409 relative links across 25 pages, including 12 heading fragments.                                      |
| Independent fresh-reader exercise                               | Located extension, retry, state/recovery, and setup/check owners; sampled A2, A3, A4, and A6 against source.     |
| Reader-reported navigation defects                              | Two nonexistent judge links corrected to LocalRuntime in index.ts; lifecycle anchor corrected to launch/control. |
| `git diff --check`                                              | Passed.                                                                                                          |
| Before/after behavior-file fingerprint                          | Identical SHA-256 across source, tests, scripts, CI, manifests, and build/configuration files.                   |

The fingerprint was **9B3571061722B053BEA241ADF476EF731EB9B2BF716DA4F1A6B4F5EBCECF8513** before and after the audit.
The full application validation and production build were not rerun for these documentation changes.
No behavior, dependency, generated artifact, or saved workspace change was made.

No live provider, current browser, native Mac, production-data, or remote CI acceptance was performed.
The component diagram was checked against import and composition owners; no graphical Mermaid renderer was used.
No performance benchmark or exhaustive security review is implied.

## Implementation follow-up

The October 23, 2026 implementation resolves the eight findings within the existing engine and runtime boundaries.
Existing uncommitted work, saved workspace data, sealed evidence, and the retired repository remain intact.
No dependency was added.

| Finding | Resulting ownership and regression evidence                                                                                                                                                                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1      | One invocation permit owns the complete bounded process plan; [native Bedrock fixtures](../src/runtime/bedrock.test.ts) cover parallel work at capacity one, and [lease fixtures](../src/runtime/process-invocation.test.ts) cover cancellation, shutdown, bounds, and genuine cleanup failure.                                |
| A2      | Research drains authorized original and adopted attempt events and rejects responses above 16 MiB without partial output; [HTTP fixtures](../src/application/audit-projections.test.ts) cover late events, gold access, adopted sources, and size limits.                                                                      |
| A3      | Frozen identity-bound credential versions serve targets, judges, and researchers; transient probes capture credentials without retaining unused versions. [Connection fixtures](../src/runtime/connections.test.ts) cover rotation, deletion, restart, canonical identity, copied workspaces, redaction, and in-flight probes. |
| A4      | [ComparisonService](../src/application/comparisons.ts) owns both comparison paths using logical availability and frozen assessment provenance; [HTTP fixtures](../src/application/audit-projections.test.ts) preserve partial recovery and historical scores.                                                                  |
| A5      | New publication and draft checks reject policies without an active grader; historical grading and [export](../src/application/historical-export.test.ts) retain recorded semantics and structural compatibility.                                                                                                               |
| A6      | The seeder uses shared judge evidence and an injectable isolated directory; maintained TypeScript scripts enter regular type checking. [Tooling acceptance](../tests/acceptance/audit-tooling.test.ts) verifies recorded LLM verdicts.                                                                                         |
| A7      | [Model discovery](../src/runtime/model-catalog.ts) owns aggregate byte/model/page/time bounds and explicit failures; [catalog fixtures](../src/runtime/model-catalog.test.ts) cover parsing, pagination, cancellation, transport, and incomplete responses.                                                                    |
| A8      | Server URLs bracket IPv6 hosts; [transport fixtures](../tests/acceptance/audit-tooling.test.ts) exercise discovery and CLI use on IPv4, localhost, and IPv6.                                                                                                                                                                   |

Independent review caught and resolved two follow-up issues before acceptance.
Historical package export uses structural validation rather than current authoring restrictions.
Ordinary probes preserve their captured credential pair without retaining unused secret versions after rotation or deletion.
Both corrections received failing regression tests before implementation and independent source rechecks afterward.

An isolated public HTTP journey uses the actual 65-question bank with clearly labeled synthetic runtime responses.
It verifies publication, launch replay, linked retry and idempotent application, comparison, deterministic rescoring, human review, export, and restart durability.
Captured public target questions contain no gold field, and the journey makes no provider calls.
This establishes workflow behavior rather than provider protocol compatibility or analytics accuracy.

Final integrated validation passes on Windows with Node.js 25.6.1.

| Check                      | October 23 result                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run validate`         | Passed formatting, 167 production-module boundary checks, type checking including scripts, lint, 674 tests, and the production build; 14 tests were skipped.         |
| Independent review         | Both review findings were reproduced, corrected, and rechecked; the final JSON-boundary correction also passed independent source review.                            |
| Actual-bank HTTP journey   | Passed the 65-question workflow above with synthetic target responses and no provider calls.                                                                         |
| Browser retry/application  | Completed the acknowledged retry and application dialogs, then displayed 65/65 answered and zero remaining execution failures.                                       |
| Browser comparison         | Displayed matching logical outcomes for the recovered and complete Runs; selecting the original historical score retained 64/65 judged while answers remained 65/65. |
| Browser layout and console | Inspected the comparison dialog at the current desktop viewport; no warnings or errors appeared in captured browser logs.                                            |
| Build identity             | The verified browser served build `2026-10-24T05:50:02.874Z`, corresponding to October 23 in the local timezone.                                                     |

The first full-suite run identified a fixture that bypassed the real judge configuration resolver.
Updating the fixture exposed undefined optional metadata in frozen bindings at the JSON request boundary.
The production boundary now omits unset metadata, with regressions for new/reused snapshots and all four supervised judge-failure modes.
The final complete validation run passes after that correction.

The build retains a nonblocking Vite warning for a JavaScript chunk above 500 kB.
Live provider authentication, native Mac acceptance, remote CI, and analytics answer accuracy remain unverified.
Existing workspace credentials and evidence were not used or changed by acceptance fixtures.
