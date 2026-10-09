# Architecture

## Dependency direction

React and the CLI call transport adapters, which call one application command dispatcher.
Application services own catalog rules, run lifecycle, research coordination, and evaluation requests.
Concrete SQLite storage persists records and an ordered event log.
Runtime ports encapsulate provider discovery, connection secrets, target execution, judging, and persistent researcher turns.
Evaluation reads immutable results and never reruns a target.

## Domain vocabulary

| Concept            | Meaning                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| Bank revision      | Published questions and expected evidence.                               |
| Evaluator revision | Published deterministic rules and optional custom code.                  |
| Blueprint          | Reusable agent and launch settings.                                      |
| Run                | One frozen configuration, question set, and repetition count.            |
| Result             | One question and repetition, with recorded execution attempts.           |
| Attempt            | A physical target invocation, including interrupted invocations.         |
| Assessment pass    | Named frozen judgments, coverage, and provenance over one Run.           |
| Score set          | Internal deterministic evidence under one evaluator revision.            |
| Research session   | One persistent researcher conversation and its ordinary child Runs.      |
| Human review       | A derived assessment pass with attributed edits and untouched judgments. |
| Jev profile        | Published bank-level instructions and criteria for classification.       |
| Jev assessment     | A saved classification request and result for one sealed attempt.        |

## Lifecycle ownership

The engine owns a single local workspace through an exclusive process lock.
It persists requested intent separately from observed run status.
Pause stops admissions and lets active attempts settle.
Halt stops admissions and interrupts active attempts; Resume starts fresh attempts for unfinished questions.
Cancel interrupts active work and becomes terminal only after cleanup settles.
Completed question results are never repeated on Resume.
Startup converts abandoned active work to resumable interruption and preserves partial events.
Runtime cleanup failures remain visible and prevent unsafe reuse of capacity.
The runtime queues invocations that share a Tableau session credential and emits a waiting event before acquiring that connection.
Queued invocations remain cancellable and start provider processes only after admission.

## Immutability and evidence

Published revisions and run manifests are append-only records.
Expected answers stay in engine-owned manifests and never cross the public question boundary.
New bank revisions publish a public answer format for typed tables using declared column names and types.
The catalog permits nulls in automatically derived formats because reference nullability does not establish a source constraint.
Explicit author formats retain their null rules, but cannot exclude nulls allowed by the reference declaration.
Expected rows, values, and counts remain private.
Public evaluation guidance exposes declared ordering requirements without reference rows.
The catalog rejects a public format that contradicts the declared reference structure.
Existing bank revisions and run manifests remain unchanged, including their frozen public formats.
Shared contract helpers generate the submission schema and validate its structure before the runtime seals an answer.
Malformed submissions return corrective feedback without recording an answer.
After recording an answer, later submissions receive an immutable-answer receipt without replacement or corrective retry instructions.
Every attempt preserves events and its final response.
Only completed, sealed responses become grading input.
Rescoring adds a score set and cannot change historical researcher decisions.
Explicit evaluator column aliases map reviewed submitted names to canonical reference names without changing saved answers.
Alias comparison preserves values, duplicate rows, row coverage, and ordering requirements, and rejects ambiguous mappings.
Typed table evaluation accepts a JSON-encoded row array without applying that conversion to arbitrary text answers.
Exports contain the saved Run's resolved agent settings and placeholder connection credentials.
They contain no question bank, expected answers, evaluator golds, or private secrets.

## Storage and schema ownership

`Database` exposes a typed record map and indexed queries scoped by Run, result, bank, session, or status.
SQLite constraints reject changes to published revisions, manifests, and completed attempt evidence.
Score publication can change from preview to published; assessment contents remain fixed.
The database records schema version 5 and rejects a newer unknown version.
The transactional migration from version 1 preserves existing records and idempotency keys while adding classification records.
Version 3 extends blueprint immutability to target settings without rewriting existing record bytes.
Version 4 adds a durable workspace identity used to isolate browser drafts without changing existing Run evidence.
Version 5 adds named assessment passes and bank findings through a transactional record-table migration.
Future schema changes require an explicit transactional migration and recovery tests.
An exclusive SQLite transaction in a separate ownership file provides a crash-released local lock.
The ownership file contains no product records.

Run startup reconciles unfinished attempts before admitting work.
It also recovers missing deterministic assessments from sealed completed answers without another target or judge call.
Evidence finalization uses a staging file and an atomic rename before saving its hash in SQLite.
Unreferenced staging files never become grading input.

## Observation queries

Workspace queries return catalog summaries and paginated Run summaries.
Initial Run reads include the frozen manifest; live observation reads omit that immutable payload.
SQL projections remove transcripts, custom grading details, and evaluator code before deserializing observation summaries.
Event previews are bounded and use durable cursors.
Selected attempt queries return full evidence and assessments, while scoped event queries provide live tool details.
Research observation omits prior turn inputs and transcripts; a deliberate turn query retrieves full conversation evidence.
Jev observation includes classifications and status summaries; a deliberate assessment query retrieves the full request, response, and evidence.

## Independent classification

The application judging service owns bank profile publication, frozen selection, evidence assembly, and assessment publication.
The runtime classifier port resolves TypeSafe credentials and performs the bounded HTTP request.
Classification does not require a target harness process.
The existing LLM judge and Jev can operate independently or together, with separate assessments and spending records.

The evidence builder reads a sealed attempt and verifies its hash.
It uses the recorded provider transcript when available and otherwise drains all pages of the scoped event history.
It excludes previous assessments and combines reference answers with the effective deterministic acceptance settings.
Jev profile overrides inherit bank criteria unless an override explicitly replaces a field.

The request is checkpointed before HTTP admission.
Completed or failed assessments preserve their evidence and provider provenance; publication only changes their published state.
Preview publication performs no additional inference.
Startup marks unresolved judging requests explicitly instead of silently retrying potentially billable work.
Completed target evidence missing its configured original assessment receives an explicit unavailable assessment.
Research evidence retrieval exposes safe classification summaries without revealing profile criteria or raw requests.
Jev records preserve the complete sealed evidence and hashes, while each provider request follows the frozen profile's evidence requirement.
Answer-only requests omit internal-activity trace data without changing the saved evidence record.
Jev pass correctness uses the answer choice and its frozen confidence threshold; the overall review flag remains a separate audit signal.
Research candidate promotion retains its stricter requirement that the complete Jev assessment is not flagged for review.

## Module ownership

| Path               | Responsibility                                                    |
| ------------------ | ----------------------------------------------------------------- |
| `src/contracts.ts` | Public schemas, records, and runtime ports.                       |
| `src/application/` | Command dispatch and focused application services.                |
| `src/domain/`      | Pure lifecycle and input rules.                                   |
| `src/storage/`     | SQLite transactions, revision persistence, and events.            |
| `src/evaluation/`  | Deterministic scoring and bounded custom code.                    |
| `src/runtime/`     | Target adapters, connections, discovery, and process containment. |
| `src/server.ts`    | Local HTTP transport and static web delivery.                     |
| `src/cli.ts`       | JSON CLI transport client and discovery.                          |
| `src/web/`         | React presentation and form state.                                |

## Runtime infrastructure

`runtime/platform.ts` selects process and secret-store implementations at composition time.
Windows and macOS use the same connection, provider, and invocation workflows.
Provider adapters do not choose an operating system or import concrete platform implementations.

`ProcessSupervisor` owns shared invocation scheduling, output bounds, deadlines, cancellation, and shutdown.
Process drivers own native launch, durable scope identity, cleanup, and startup recovery.
Windows Job Objects enforce hard descendant limits; macOS managed process groups support cooperative providers without claiming equivalent containment.
Executable resolution owns platform launcher mechanics separately from process coordination.

Connection services coordinate credential validation and replacement through `SecretStore`.
Secret infrastructure owns DPAPI or Keychain access and local workspace ownership without depending on process supervision.
Versioned connection persistence records opaque references and recoverable cleanup intents.
Legacy ciphertext conversion is isolated from ordinary connection operations.

Automated import checks separate credential infrastructure, process infrastructure, connection services, and shared coordination.
Platform decisions belong in composition or executable-resolution mechanics.
Native Mac validation remains a release requirement; portable tests and configured CI do not substitute for recorded Mac execution.

## Research continuity

A completed baseline precedes the first researcher turn.
The initial bundle includes instructions, guidance, objective, configuration, mutation limits, budgets, and baseline identifiers.
It excludes banks, gold answers, transcripts, and prior configuration history.
The researcher requests evidence explicitly through a restricted read interface.
Gold retrieval creates an audit event.
Each later turn resumes the exact provider conversation ID.
Context exhaustion or unavailable continuity stops the session without silently creating another conversation.
Each provider invocation and its pending input are checkpointed before admission.
Provider-native cumulative usage is counted once per conversation.
OpenCode usage includes cache reads and writes in input tokens and separate reasoning tokens in output tokens.
Identical step identifiers count once; conflicting duplicates or incomplete token components leave usage unknown.
Missing cost stays unknown, and inclusive Codex counts do not receive additional cache or reasoning counts.
Target and independent judge usage contribute separately to research spending checks.
An interrupted invocation with unavailable usage stops further admissions under a configured spending ceiling.

## Evaluation policy ownership

Contracts define declarative comparison policies, calibration examples, public answer shapes, and score provenance.
Shared numeric and temporal parsers keep public submission validation consistent with deterministic grading.
The evaluation module applies explicit policies without provider calls or reference mutation.
The application validates policies against bank revisions, gates evaluator publication on labeled calibration cases, and freezes corrected references in new score sets.
The web app and CLI use the same calibration, preview, publication, and rescore commands.
Unscorable references remain distinct from incorrect answers, grading errors, and failed target execution.
Optional judges can abstain and never replace deterministic assessments automatically.

## Tradeoffs

A single local owner avoids distributed coordination and keeps lifecycle decisions inspectable.
SQLite and local artifacts suit a workstation app and do not provide multi-host scheduling.
Live Tableau data is not frozen by a Run manifest.
Comparisons identify differing question sets and evaluator revisions rather than presenting incompatible aggregates as equivalent.

## Target ownership and adapters

A Run freezes one target: a managed agent configuration or a versioned external adapter configuration.
The compatibility reader interprets existing agent manifests without modifying stored records or artifact hashes.
All new launches and blueprints write the target contract.
AgentConfig remains the configuration for managed targets, researchers, and local judges.

Application services own Run lifecycle, sample operations, evidence sealing, evaluation compatibility, and recovery journals.
TargetInvocations persists private resource checkpoints independently of immutable answer evidence for both samples and runs.
Startup recovers checkpoints before admitting work, including completed answers with unresolved resource cleanup.
Adapter recovery has a bounded deadline, receives frozen configuration, and never repeats the original question.
The registry blocks admission when cleanup is unconfirmed.

Runtime composition registers internal adapters that own validation, credential binding, public preview, invocation, recovery, and cleanup.
The external catalog stores public endpoint configuration and resolves scoped opaque references through SecretStore.
Authentication values never enter manifests, exports, events, or response evidence.
Native process readiness is lazy; external-only work does not require local harness executables or native process helpers.

Generic HTTP accepts one bounded JSON POST response and records answer-only evidence.
Halt and Cancel stop local waiting without claiming that remote work stopped.
Resume requires explicit duplicate-work acknowledgment when an interrupted request might still be running remotely.
Deterministic grading remains the default; trace-dependent evaluators and judges require compatible evidence before launch.
Malformed selected answers are completed evidence with an incorrect assessment after configured representation policies apply.
Transport and protocol failures remain execution failures.

The web app presents one target-first setup and one observation workspace.
External ownership hides local prompt, model, tool, and research controls.
Future runtime integrations add an adapter and its presentation configuration; they do not add a second Run engine.
See `target-adapters.md` for maintainer responsibilities and registration points.

## Configuration and execution recovery

Settings owns saved connection configuration; Run selects saved references and keeps a tab-local, workspace-scoped setup draft.
The storage layer provides a durable workspace identity instead of deriving one from mutable catalog content.
Draft serialization includes public configuration and credential references, and rejects credential fields in advanced JSON.
Research reuse reads the recorded session configuration rather than reconstructing a researcher from its child Run.
Runtime and UI share model-setting validation and harness/provider compatibility contracts.
Help overlays render outside panel clipping boundaries, and JSON editors share reference and validation behavior.

Failure classification is recorded with each physical attempt.
Automatic retries require trusted transient metadata and evidence that retrying has no side effects.
Every physical attempt enters the same cancellation-aware admission gate, including retries after reduced concurrency.
Research budgets are checked again after admission waits.
Failed-attempt usage contributes when known and remains unknown when unavailable.
Manual retry creates a linked Run with the identical frozen manifest and only selected failed result slots.
Original scores, attempts, and research decisions remain immutable; comparisons include actual question/repetition slots.

The built-in Bedrock runtime uses non-streaming Converse behind the managed runtime contract.
It uses the same supervised MCP bridge lifecycle, frozen tool allowlist, answer submission, and researcher evidence boundaries as local harnesses.
Research conversations preserve exact identity and recorded message history; unresolved requests cannot be silently resumed.
OpenCode's separate Bedrock path requires streaming support.

## Named assessment passes

One Run contains any number of named deterministic, LLM, Jev, and human assessment passes.
AssessmentPassService owns pass creation, retry, selection, human derivation, and exports through the common command dispatcher.
The evaluator continues to own deterministic scoring, and JevService owns recorded classification requests.
Score sets and per-request classification records remain detailed evidence behind the single pass selection presented by the app.
Published deterministic rescoring appears in the same pass list.

Every pass freezes its evaluator, reference revision, optional judge configuration, eligible result slots, exclusions, and source lineage.
The service checkpoints judgments before further admissions and seals a completed pass against mutation.
Restart marks unfinished passes interrupted without repeating potentially billable requests.
Retry creates a new pass, carries successful judgments forward, and evaluates only failed or unfinished judgments with sealed target answers.
Completed abstentions and failed target executions do not become automatic judge retries.
No assessment operation invokes the target agent.

Human derivation copies the entire parent judgment set and records reviewer, note, previous judgment, and timestamp for each edited result.
Failed executions accept notes and explicit exclusions but cannot receive a correctness verdict without a sealed answer.
Reviewing a paused original creates an immutable parent snapshot before the derived review.
Pass exports include frozen references and judge request, response, error, and evidence-hash provenance when available.
Observation projections omit raw requests, responses, and reference payloads; deliberate pass reads retrieve them.
JevService owns the optional single fallback after a trace size error, its shared deadline, and saved provenance.
The runtime classifier translates the requested check scope and validates exactly those decisions.
Dedicated versioned fallback criteria assess the complete answer without a trace; omitted checks remain unassessed and block automatic research promotion.
Fallback never modifies sealed evidence, and observation projections omit the original oversized request.

Accuracy uses correct answers divided by completed judgments with a correctness verdict.
Existing saved passes derive display rates from frozen counts without rewriting their evidence.
Research selection separately uses `eligibleOutcome`, correct answers divided by frozen eligible slots, and requires coverage that matches or exceeds the baseline.
Answered, judged, unjudged, failed, and excluded coverage remain visible independently.
Comparisons require equivalent selected sources, settings, reference answers, and eligible slots.
An empty eligible basis is not comparable.
Selecting a pass persists a Run preference without changing its manifest or historical research decisions.

Performance queries keep target, researcher, and judge usage separate.
Each field preserves its reported subtotal and counts pending and unreported invocations separately.
A field is unknown when invocations exist but none report that field; no invocations produce zero.
Stored `inputTokens` includes cached input and remains the budget-accounting total.
Presentation uses explicit uncached input, generated output, and reused cache fields.
Uncached input is derived per invocation only when both inclusive input and a valid cache count exist.
Older target attempts recover cache from bounded provider usage events only when normalized input and output exactly match sealed usage.
Recovery reads at most 4,096 usage events and 1 MiB per attempt, with a 1,000-entry least-recently-used cache for settled attempts.
Missing or inconsistent breakdowns remain unreported, and sealed evidence is never rewritten.
Strict budget accounting remains separate from partial display totals.
Copied judgments share a physical judgment identifier, so a retry does not double-count successful requests.
Research conversation usage contributes per-turn increments rather than repeatedly counting cumulative totals.
Bank findings link question revisions to saved Run evidence and preserve explicit accept or dismiss decisions.
Accepted corrections publish a bank revision, and accepted exclusions publish evaluator policy; existing evidence remains unchanged.

## Observation workspace

Live and saved Runs open on Questions, followed by Summary, optional Research, and Configuration.
A compact shared strip shows every saved assessment score with judgment coverage and errors.
Results presents one row per Run with one remembered assessment selection.
Question-bank and setup answer-size warnings are estimates and never block launch or truncate judging evidence.
The build includes a visible build identifier and a local build metadata endpoint.
No analytics dashboard or additional execution hierarchy is introduced.
