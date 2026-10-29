# External evaluation targets

Generic HTTP and the internal adapter boundary are implemented.
Agentforce and Copilot Studio adapters are not registered.
This page describes current architecture and replaces the earlier implementation proposal.

Use [HTTP setup](http-targets.md) for endpoint configuration and [adapter development](target-adapters.md) for extension requirements.
The [HTTP verification record](http-target-verification.md) describes dated checks rather than current release certification.

## Ownership and composition

An external agent owns its model, prompts, tools, routing, deployment, and internal observability.
The harness owns question selection, repetitions, local admission, saved evidence, scoring, and review.
A routed remote system remains one target.

[TargetConfig](../src/contracts/targets.ts) distinguishes managed `AgentConfig` from external adapter identity, version, and configuration.
[LocalRuntime](../src/runtime/index.ts) registers `ManagedTargetAdapter` and `HttpTargetAdapter` in `TargetRegistry`.
The registry is an internal integration boundary, not a plugin loader or public SDK.
Registered adapters supply capabilities; clients cannot claim their own guarantees.

| Owner                                                         | Responsibility                                                                                       |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [RunService](../src/application/runs.ts)                      | Freeze targets, validate evidence compatibility, coordinate controls, and publish results.           |
| [TargetInvocations](../src/application/target-invocations.ts) | Persist and reconcile private recovery checkpoints.                                                  |
| [TargetRegistry](../src/runtime/targets/registry.ts)          | Select adapters, enforce admission and deadlines, validate evidence scope, and prevent unsafe reuse. |
| [ExternalTargetCatalog](../src/runtime/targets/catalog.ts)    | Save configuration and manage identity-bound credential versions.                                    |
| [HttpTargetAdapter](../src/runtime/targets/http-adapter.ts)   | Validate configuration, bind credentials, checkpoint dispatch, and normalize evidence.               |
| [HTTP mapping](../src/runtime/targets/http-mapping.ts)        | Project public inputs and select one typed answer.                                                   |
| [HTTP transport](../src/runtime/targets/http.ts)              | Perform bounded requests, classify failures, and record remote completion certainty.                 |

`RunService.launch` resolves configuration, freezes capabilities, checks evidence requirements, and retains required external credentials before publishing a Run.
Both target kinds use shared attempts, results, observation, and assessment records.
External research is rejected; judges remain independently configurable.

Target admission is separate from native process admission.
HTTP needs no installed model executable, local model account, or unused process helper.
Optional CLI judging still needs its selected local runtime.
Native product support remains Windows and macOS.

## Public request and answer boundary

`TargetInvocation` receives a `PublicQuestion`, generated IDs, repetition, limits, cancellation, events, and a durable checkpoint callback.
It receives no bank, Run manifest, expected answer, or private evaluator criteria.
`buildHttpRequest` selects explicit public sources; template constants remain user-supplied endpoint configuration.

[httpTargetSchema](../src/contracts/http-target.ts) validates endpoint protocols, authentication, headers, JSON Pointers, and request templates.
It rejects unsafe keys, overlapping bindings, missing slots, excessive nesting, reserved headers, and credential-like query parameter names.
Transport additionally rejects known configured credentials in public configuration, request bodies, or returned content.
These checks do not classify every possible secret embedded in arbitrary constants.

`executeHttpTarget` sends one synchronous JSON POST without redirects, cookies, authentication refresh, or automatic retries.
Success requires JSON, a selected answer, and a 2xx status other than 202 or 204.
Explicit null differs from a missing answer.
Malformed UTF-8, invalid JSON, missing selections, size overflow, and unsupported statuses are execution failures.

Request size is the smaller of 1 MiB and invocation `maxOutputBytes`.
Decoded response size is the smaller of 4 MiB and `maxOutputBytes`.
The deadline covers establishment and complete body reading.
External Run deadlines range from 1 second through 10 minutes, with a 120-second default.

A valid selected answer remains completed evidence when its public structure is incorrect.
Evaluation applies explicit representation policies before structure and content checks.
It makes no corrective target request.
Protocol errors remain separate from incorrect-answer assessments.

## Dispatch, controls, and recovery

`HttpTargetAdapter.invoke` awaits checkpoint persistence before dispatch.
`TargetInvocations` atomically renames the private journal, then forwards the checkpoint to application persistence.
A crash between dispatch intent and network transmission is conservatively uncertain.
An attempt identifier does not establish remote exactly-once semantics.

Transport preserves safe request and response bodies, status, timestamps, adapter identity, and observed completion.
It omits authentication and does not invent model identity, traces, usage, or cost.
Failure evidence retains safe request metadata and known status without accepting an answer.
Known credential echoes are rejected rather than redacted into a different graded answer.

Pause stops admissions and drains active work.
Halt and Cancel stop local waiting without proving remote cancellation.
Dispatched interruption retains unknown remote completion.
Resume requires explicit duplicate-work acknowledgment for an external attempt with unknown completion.
Completed results remain preserved.

`HttpTargetAdapter.recover` reports complete local cleanup and unknown remote completion without resending the question.
`TargetInvocations.recover` retains journals when reconciliation fails.
Registry recovery has a default 30-second deadline.
Unresolved cleanup blocks new target admission.
The adapter contract preserves received answers when cleanup is unavailable while withholding capacity.
HTTP owns no remote session handle, so completed local cleanup cannot establish remote termination.

## Credential ownership

`ExternalTargetCatalog` stores version 2 catalog data with public records, pending deletions, and retained references.
Each secret contains a fingerprint of adapter identity, version, and normalized public configuration.
Changed configuration requires credential rebinding rather than silent authentication transfer.
`SecretStore` enforces machine-local workspace ownership.

Replacement journals allocation before writing the secret.
The catalog adopts its reference atomically and retires the old version when no owner retains it.
Failed writes and deletions remain recoverable.
Catalog mutation is serialized within the runtime.

Runs and samples retain their frozen credential version through catalog replacement or deletion.
Retention currently lasts for the workspace lifetime.
No automatic purge or reachability-based garbage collection exists.
Copied workspaces cannot resolve or retire the source workspace's credentials.
Exports contain placeholders rather than transferable authentication.

Managed connections have a different credential lifetime, described in [runtime contracts](runtime.md#connections-and-credentials).

## Evaluation and compatibility

External capabilities declare answer-only observation, external configuration ownership, unconfirmed cancellation, no research mutation, and endpoint-only export.
[validateTargetEvidence](../src/application/evidence-requirements.ts) checks required evaluator and optional judge declarations before launch.
Saved-evidence judging can record unsupported evidence without a provider call.
Judges cannot treat missing internal traces as proof that an action was omitted.
Judging and rescoring never contact the endpoint again.

Blueprint reuse restores frozen endpoint settings rather than today's catalog entry.
Remote deployment remains mutable; a deployment label is user-supplied.
`runs.export-target` exports endpoint configuration and credential placeholders.
`runs.export-agent` remains managed-only.

[savedTarget](../src/contracts/targets.ts) interprets legacy managed manifests without rewriting bytes or digests.
New Runs store the target contract.
Current storage version and migration guarantees belong to [architecture](architecture.md#storage-and-schema-ownership).

## Scope and verification

HTTP excludes streaming, asynchronous polling, webhooks, conversational scenarios, OAuth, arbitrary scripts, and automatic candidate research.
Future session adapters must establish authentication, idempotency, cancellation, and cleanup from their own provider contracts.
The registry fixture does not establish Agentforce or Copilot Studio compatibility.

[HTTP acceptance](../tests/acceptance/http-target.test.ts) uses real loopback requests through application, server, and CLI operations.
[Transport tests](../src/runtime/targets/http.test.ts) cover types, mappings, UTF-8, limits, authentication, and cancellation.
[Registry tests](../src/runtime/targets/registry.test.ts) cover a session fixture, bounded recovery, incompatible evidence, and blocked admissions.
[Catalog tests](../src/runtime/targets/catalog.test.ts) cover credential identity, retention, replacement, and foreign workspaces.

These references identify coverage without asserting that the documentation audit ran the full suite.
Live third-party endpoints, authenticated Mac providers, and interactive Keychain behavior require separate recorded acceptance.
