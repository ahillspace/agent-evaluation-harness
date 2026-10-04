# Acceptance criteria

## Engine and transport

- CLI discovery lists operations and their JSON schemas.
- CLI and HTTP launch, control, and inspect the same durable Run records.
- Reusing a launch idempotency key returns the original Run; conflicting payloads are rejected.
- A saved Run contains one immutable agent configuration and the requested repetitions.
- Restart preserves completed results and exposes interrupted work as resumable.
- Pause drains active work, Halt interrupts it, Resume preserves finished work, and Cancel remains terminal.
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
- Judge evidence contains the complete recorded attempt trace, with credentials and previous verdicts excluded.
- Evidence exceeding provider capacity produces an explicit error without silent truncation.
- Saved-evidence judging creates a separate assessment without another target invocation.
- Publishing a saved preview makes no provider call and preserves prior assessments.
- Classification probabilities, low-confidence review status, and provider errors remain distinct from an incorrect answer.

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

## Product

- Question banks supports creation, import, editing, and evaluator revision management.
- Question imports accept validated JSON and CSV with visible row errors.
- Question authoring supports expected JSON values, tags, and public context.
- Advanced tool selection exposes discovered tools and freezes the selected allowlist.
- Blueprint reuse copies a saved Run configuration into Setup without launching or adding a required hierarchy.
- Research exposes candidate and duration budgets, explicit decisions, and exact conversation continuity.
- Run Setup supports question selection, connection, harness, model, prompt, repetitions, and optional research.
- Observe shows question progress, actual activity, answer, grading, and acknowledged controls.
- Results supports saved observation, comparisons, human review, rescoring, blueprints, and tested agent JSON export.
- Refresh preserves selected records and never launches work.
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
- Scalar and list submission formats disclose structure without exposing expected values or cardinality.
- Optional LLM judges can abstain when available evidence cannot support a verdict.

## Validation record

Record executed unit, integration, browser, and bounded provider checks in the final delivery report.
Clearly distinguish implementation coverage from checks blocked by local authentication or unavailable provider software.

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
