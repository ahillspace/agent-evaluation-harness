# Acceptance criteria

## Engine and transport

- CLI discovery lists operations and their JSON schemas.
- CLI and HTTP launch, control, and inspect the same durable Run records.
- Reusing a launch idempotency key returns the original Run; conflicting payloads are rejected.
- A saved Run contains one immutable agent configuration and the requested repetitions.
- Restart preserves completed results and exposes interrupted work as resumable.
- Pause drains active work, Halt interrupts it, Resume preserves finished work, and Cancel remains terminal.
- A scope whose final slot settles nonfatally under Pause or Halt completes; a paused researcher can resume without another target request.
- Cancel remains terminal through late answers, unavailable cleanup, cleanup failures, fatal catches, and startup recovery.
- Baseline and candidate creation commit with fresh research intent and ownership validation, durable receipts, and parent linkage before scheduling.
- Pause preserves pending proposals and conversations, and paused initialization can resume without admitting stale or orphan target work.
- Startup normalizes completed recovered scopes after deterministic and judge recovery, before freezing automatic scores.
- Failed Resume readiness leaves parent and child unchanged, and competing controls cannot be overwritten by stale admission.
- Cursor reconnect returns durable observation events without creating duplicate work.

## Evaluation

- Target inputs and agent exports contain no gold answers.
- New typed table questions expose frozen column requirements without reference rows or values.
- Automatically derived public formats permit nulls without changing private reference null rules or existing revisions.
- Explicit public formats preserve author choices, permit wider nullability, and reject narrower nullability than the declared reference.
- Invalid submissions receive structural feedback and can be corrected before the answer is sealed.
- Submissions after sealing preserve the recorded answer and return a receipt that instructs the target to stop submitting.
- Reviewed column aliases rescore saved answers without ignoring wrong values, missing rows, or ambiguous mappings.
- The default evaluator handles exact, text, numeric, and JSON comparisons with explicit settings.
- Custom evaluator code has bounded time, memory, and output with no ambient filesystem or network.
- Disabled judging makes no judge calls.
- Judge errors and human reviews remain separate from deterministic verdicts.
- Draft preview shows changed scores without publishing or overwriting prior evidence.
- Publication, activation, reversion, and rescoring preserve revision history.
- Comparison reports incompatible evaluation bases.
- Jev can run independently of, or alongside, the LLM judge without replacing deterministic grading.
- Published Jev profiles preserve instructions, criteria, model selection, and question-specific overrides when configured.
- Saved Jev records preserve complete sealed attempt evidence and hashes, while provider requests follow the frozen evidence requirement and exclude credentials and prior verdicts.
- Evidence exceeding provider capacity produces an explicit error without silent truncation.
- An explicitly enabled Jev fallback makes one answer-only request after a trace size error, using frozen dedicated criteria and the remaining assessment deadline.
- Fallback preserves the original request and error, marks omitted checks Not assessed, and retains complete sealed evidence without changing hashes.
- Saved-evidence judging creates a separate assessment without another target invocation.
- Publishing a saved preview makes no provider call and preserves prior assessments.
- Classification probabilities, low-confidence review status, and provider errors remain distinct from an incorrect answer.
- Jev pass correctness uses the answer decision and frozen answer confidence threshold independently of auxiliary review flags.
- Research candidate promotion retains its stricter requirement that a Jev assessment has no overall review flag.

## Runtime and research

- Codex and OpenCode discovery reports installed harnesses and available authentication without fabricating models.
- Tableau connections can be configured and inspected without returning credential values.
- Target execution emits real normalized tool and message events.
- Invocations waiting for a shared Tableau connection emit a waiting event and remain cancellable before provider startup.
- OpenCode usage includes cache and reasoning components exactly once, deduplicates step identifiers, and preserves unknown usage and cost.
- Halting an attempt cleans up its process descendants.
- Research starts only after a completed baseline and retains the exact provider conversation ID.
- Research candidates launch through the same engine as manual Runs.
- Gold retrieval requires an explicit audited request.
- Research limits stop additional target and researcher admissions.
- Reopening settled research preserves its saved bytes, while each interrupted researcher admission becomes one missing usage report without remaining pending.
- Research startup preserves request evidence, reconstructs committed baseline linkage, and rejects lost conversation continuity without invoking a provider.
- Persisted terminal research checkpoints settle once while preserving lifecycle and captured input; interruption audit and checkpoint consumption commit atomically.
- Stale initialization cannot release research ownership while a newer researcher drains, admit an early Resume, or enable manual Run takeover.
- Missing admission counts with saved history remain unknown in observation and prevent all new research work before candidate creation, regardless of spending limits.

## Product

- Question banks supports creation, import, editing, and evaluator revision management.
- Publishing a bank draft creates question and evaluator revisions atomically after validating formats, policies, and calibration examples.
- Stale source revisions and concurrent publication changes reject the draft without partial publication.
- Every bank creation and revision entry point calibrates the proposed content; existing-bank publication requires both revision guards.
- Historical findings cannot correct or exclude a changed question, and rejected calibration or competing decisions leave no partial publication.
- A second editor retains unsaved changes when another editor publishes; draft recovery fetches current published content and preserves edits on failure.
- Inline sample checks, calibration, and saved-answer previews use proposed questions and rules without provider calls or catalog writes.
- Complete versioned bank exports preserve questions, evaluator settings, optional Jev profiles, and source revision identifiers.
- Question imports accept validated JSON and CSV with visible row errors.
- Question authoring supports expected JSON values, tags, and public context.
- Advanced tool selection exposes discovered tools and freezes the selected allowlist.
- Blueprint reuse copies a saved Run configuration into Setup without launching or adding a required hierarchy.
- Research exposes candidate and duration budgets, explicit decisions, and exact conversation continuity.
- Runs combines the execution library, new-run setup, and live or saved Run details under one navigation destination.
- New run supports question selection, connection, harness, model, prompt, repetitions, and optional research.
- Observe shows question progress, actual activity, answer, grading, and acknowledged controls.
- Runs supports saved observation, comparisons, human review, rescoring, blueprints, and tested agent JSON export.
- Runs filters all saved Runs before pagination, with matching Unicode normalization for search text and stored labels.
- Canonical Runs routes and legacy aliases preserve session, question result, saved score, source Run, and blueprint selections.
- Setup drafts retain their workspace and tab identity across equivalent routes without resetting or launching work.
- Run summaries exclude full target configurations and evidence while preserving selected scores, live coverage, and applied answer counts.
- Bank grading previews page the selected bank independently of the latest workspace Runs and preserve selection across pages.
- Catalog migration adds scoped query indexes transactionally and preserves existing record bytes after success or failure.
- Refresh preserves selected records and never launches work.
- Lost Run and research launch responses recover with the same persisted request and idempotency key after navigation or reload.
- Concurrent research launch retries wait for one complete baseline receipt, and restart reconnects an existing baseline without repeated work.
- Research initialization without a saved baseline reports an explicit failure and cannot navigate to an empty Run identifier.
- Acknowledged launches clear pending requests, while an intentional new evaluation receives a new key.
- Datasource selection shows names and projects, preserves exact IDs across pages, distinguishes empty results from errors, and retains manual-ID recovery.
- Datasource pages use provider-owned bounded queries, and search semantics match the provider's supported filters.
- Settings follows direct and browser-history route changes without a competing selected-tab state.
- Keyboard navigation and narrow layouts remain usable.
- No synthetic telemetry is presented as a real provider result.

## Evaluator reliability

- Decimal precision and tolerances can apply independently to declared numeric columns.
- Calendar dates and timezone-qualified instants use explicit comparison policies with strict validation.
- Explicit extraction and scalar singleton policies preserve missing, extra, and contradictory answer distinctions.
- Top-k alternatives require a complete reference pool and preserve rank, membership, and duplicate counts.
- Reference defects can produce unscorable outcomes with a reason and visible coverage.
- Labeled acceptable and unacceptable examples calibrate evaluator drafts without target calls.
- Publication rejects failed calibration cases and validates against the latest bank revision.
- Saved answers can be previewed and rescored against an explicitly selected compatible reference revision without changing the original Run.
- Both evaluator previews compare against the current automatic deterministic basis after recovery while preserving historical scores.
- Scalar and list submission formats disclose structure without exposing expected values or cardinality.
- Optional LLM judges can abstain when available evidence cannot support a verdict.

## Validation record

Record executed unit, integration, browser, and bounded provider checks in the final delivery report.
Clearly distinguish implementation coverage from checks blocked by local authentication or unavailable provider software.

## Observation redesign

- One Run supports named deterministic, LLM, Jev, and human assessment passes with frozen configurations and references.
- Saved-answer assessment and retry never rerun a target; retry carries successful judgments forward.
- Failed and oversized judge requests remain unjudged errors with inspectable request and response evidence.
- Human review preserves untouched judgments, records overrides, and supports notes on failed executions.
- Runs remembers each Run's selected pass and shows one matching score summary, question judgments, and correct / judged accuracy with separate coverage.
- Research selection retains a fixed eligible objective and coverage guard.
- Unknown target, researcher, and judge usage appears as unknown instead of zero.
- Question findings link saved evidence and require an explicit decision before publishing corrected references or exclusions.
- Live and saved Runs open on Questions, followed by Summary, Research when applicable, and Configuration.
- The built app exposes its build identifier, and the analytics dashboard remains outside this redesign.

## External targets

- Generic HTTP sends public questions, context, and answer-format guidance without gold answers or evaluator criteria.
- Preview performs no network operation; sample requests explicitly invoke the configured endpoint.
- Request mappings preserve JSON types and use declarative JSON Pointers without executable scripts.
- Credential storage supports none, bearer tokens, and API key headers without exposing secret values.
- Transport enforces deadlines, size limits, TLS validation, no redirects, no automatic retries, and loopback-only HTTP.
- Missing selections, malformed JSON or UTF-8, asynchronous responses, and non-success statuses are execution failures.
- Invalid public answer structure remains completed evidence and receives an incorrect assessment after representation policies apply.
- Pause drains work; Halt and Cancel preserve uncertain remote completion; Resume requires acknowledgment before possible duplicate work.
- Both sample and Run checkpoints recover through the same bounded adapter lifecycle without resending questions.
- Unresolved cleanup prevents new target admission without discarding a received answer.
- Saved Run configuration, blueprints, comparisons, rescoring, and exports work for external targets.
- External exports describe endpoint invocation only and contain credential placeholders.
- External-only work does not start local discovery or require a native process helper.
- An internal session adapter fixture proves registration, invocation, cleanup, and bounded recovery.
- Existing managed records remain readable and their stored bytes remain unchanged during migration.

## Configuration and recovery usability

- Settings distinguishes subscriptions, saved API keys, and company gateway bearer tokens.
- Supported OpenAI Codex, Anthropic Claude Code, OpenCode, and built-in Bedrock options remain visible independently of local installation.
- Non-streaming Bedrock Converse supports target, researcher, and judge roles without requiring ConverseStream.
- Run drafts survive navigation and reload without sharing mutable drafts between tabs or workspaces.
- Reuse restores research configuration, including researcher, instructions, limits, and authentication references.
- Models and tools refresh automatically when the relevant configuration changes, without replacing manually entered model IDs or selected tools.
- Questions supports search, answer-type and tag filtering, select all, and deselect all.
- Section help uses plain-language explanations and stays within the viewport.
- JSON settings include valid examples and runtime-aligned validation.
- Execution failures remain separate from incorrect answers; all physical attempts and available usage remain inspectable.
- Safe transient failures receive bounded retries through the same admission controls as ordinary work.
- Manual recovery uses the original Run, logical Result identifiers, frozen manifest, and physical attempt ownership.
- Explicit failed-slot subsets leave unrelated failed, interrupted, and never-started slots untouched.
- Completed answers, including incorrect answers and historical adopted answers, cannot be selected for target recovery.
- Each recovery creates a full-Run automatic score while preserving every saved score and answer binding.
- Recovery selects its deterministic score at admission, and settlement preserves later user score selection.
- Same-key concurrent recovery and Resume requests admit one scope; accepted replay never schedules more work.
- Stale new execution actions, competing active requests, and configuration drift fail before partial admission.
- Pause, Halt, and restart preserve an unsettled execution scope; a settled continuation admits pending or interrupted slots only.
- Cancel remains terminal even when failed slots remain.
- Unknown selected remote completion requires acknowledgment, and unresolved cleanup prevents unsafe admission.
- Automatic transient retry limits apply per admitted question execution while physical attempt ordinals remain monotonic.
- Target and automatic judge admissions use immutable attempt budget attribution; standalone usage never inherits historical research provenance.
- Run time sums active segments, excludes idle and restart downtime, and reports incomplete timing when a crash prevents proof.
- Historical child Runs, retry applications, adopted answers, and their saved scores remain readable without retired write commands.
- Manual failed-slot recovery and pending/interrupted continuation from terminal research use normal frozen Run limits and a fresh Run-controlled execution.
- New manual target and automatic LLM/Jev attempts have explicit execution identity without research-budget attribution or inherited research deadlines.
- Original research records, decisions, first scores, outcomes, conversation, and spending remain unchanged while Run lifetime totals include manual work.
- Live, paused, or halted research cannot be taken over, outstanding target/judge/assessment work blocks admission, and cancelled Runs remain terminal.
