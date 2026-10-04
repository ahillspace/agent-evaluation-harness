# External evaluation targets

Status: implemented; validation is recorded in `http-target-verification.md`.
This document supersedes the earlier deferred HTTP design note.
The generic HTTP adapter and internal runtime boundary ship together.

## Product decision

Evaluate an external agent by sending public questions to an HTTP endpoint and grading its returned answers.
The external system owns its model, system prompt, tools, routing, deployment, and internal observability.
The harness owns question selection, repetitions, request admission, saved evidence, scoring, and review.
A routed multi-agent system is one evaluation target.

Keep one Run workflow for managed agents and external agents.
The first external adapter is generic HTTP.
Build the internal adapter boundary in the HTTP release, with Agentforce as the first intended future provider integration.
Product developers add and maintain runtime integrations in this codebase; end users configure only integrations shipped with the app.
The boundary establishes the shared architectural decisions now so future integrations, such as Copilot Studio, require provider-specific implementation rather than architectural redesign.
Do not implement or display unavailable Agentforce or Copilot Studio options.

### Scope

- Synchronous JSON POST requests with bounded declarative input and answer mapping.
- Reusable named endpoint configurations, stored credentials, and frozen Run snapshots.
- Existing deterministic evaluation, optional LLM and Jev judging, review, comparisons, rescoring, and blueprints.
- Request status and answer observation through the existing Observe page.
- Equal command support through the CLI and browser.

### Exclusions

No remote prompt editing, model selection, tool configuration, deployment management, or automatic candidate research.
No internal traces, event ingestion, remote tool timelines, or custom observability interface.
No streaming, asynchronous polling, webhooks, conversational test scenarios, arbitrary mapping code, OAuth flows, or automatic retries in the HTTP release.
No Agentforce implementation, plugin loader, public adapter SDK, or general integration workflow engine.

## User experience

Keep the main navigation: Question banks, Run, Results, and Settings.
Keep Run split into Setup and Observe.
Use the existing left-side setup sections and help controls.
Use "Local engine" for workspace status; do not imply that an external target executes locally or that requests remain on this machine.

### Setup

Choose the target first so subsequent sections contain only applicable controls.
Use the label **Agent under test** with two choices: **Configure an agent** and **Use an external agent**.
These are product choices, not additional execution hierarchies.

| Setup section      | Managed agent                                                            | External HTTP agent                                                          |
| ------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Agent under test * | Codex or OpenCode, model, instructions                                   | Saved external agent, or Add external agent                                  |
| Questions *        | Bank revision and question selection                                     | Same bank revision and question selection                                    |
| Tools              | Tool connections and allowlist                                           | Section absent                                                               |
| Evaluation         | Repetitions, applicable limits, deterministic evaluator, optional judges | Same evaluation controls; request timeout and concurrency, without max turns |
| Research           | Existing optional candidate improvement                                  | Section absent; a short explanation appears in target details                |

Move tool connection selection out of Questions and into the managed target's Tools section.
Question context belongs to the bank and remains available to both target types.
Do not require a Tableau connection to evaluate an external agent.
Judge credentials remain independently configurable even when target model credentials are unavailable.
Required markers indicate sections needing a user choice; valid defaults do not create unnecessary required steps.

The external target card shows its name, endpoint origin, adapter, credential readiness, and an optional user-supplied deployment label.
It explains: "Your external system controls this agent. The harness sends questions and evaluates the answers."
Switching target types keeps questions and evaluator choices but clears incompatible target settings from the launch payload.
Returning to a type can restore unsaved form state locally; hidden settings never enter a Run manifest.
Reject unsupported fields and research requests at the application boundary, regardless of UI visibility.

### External agent configuration

Add **External agents** inside Settings, beside existing connection and local runtime settings.
Use the same focused editor when adding an agent from Setup, then return to the selected Run draft.
Do not introduce a new mandatory top-level catalog workflow.

The primary form contains a name, endpoint URL, authentication selection, request question field, and answer field.
Defaults use `question` in the request and `answer` in the response.
Advanced settings contain the JSON body template, public context and format bindings, non-secret headers, and optional deployment label.
Provide a safe request preview with a sample question and credential placeholders.
Validation checks configuration without contacting the endpoint.
**Send sample request** is a separate explicit action that shows the exact sample input and can invoke real remote work.
It never sends an expected answer and does not count as a scored Run.
Show response status, extracted answer, and mapping diagnostics in that editor.

### Observe

Retain the existing progress, selected-question, answer, score, and control layout.
Replace the managed agent activity panel with request activity for external attempts.
Show Waiting, Request sent, Awaiting answer, Answer received, and Evaluating when those states actually occur.
Show elapsed request time and bounded response details on deliberate expansion.
Do not infer remote reasoning, tool activity, model identity, token usage, or percentage complete.
Use "Internal activity is managed by the external system" as explanatory text, not an empty trace viewer.
External usage and cost display as unavailable; separately measured judge usage remains visible.

Halt and Cancel explain that the harness stops waiting and cannot confirm whether remote work stopped.
Keep the acknowledged local control state distinct from remote completion certainty.
Do not display "Agent stopped" for an aborted HTTP request.

### Results, reuse, and export

Results identify target type, adapter, saved target name, and optional deployment label.
Compare answer quality using the same evaluation-basis compatibility rules as managed Runs.
Label request elapsed time as client-observed latency, not model compute time.
Missing external cost, usage, and traces remain unavailable and never become zero.

Using a Run as a blueprint restores its frozen endpoint configuration, mappings, limits, and evaluation settings.
It does not silently substitute today's saved endpoint settings.
Missing or inaccessible credentials require rebinding before launch.
Editing or deleting a catalog entry does not alter historical Runs.

Expose **Export target configuration** for every target.
Managed exports retain the complete tested agent settings and system prompt.
HTTP exports contain only known endpoint configuration and credential placeholders, with explicit external ownership.
They do not claim to export the remote agent implementation or freeze its deployment.
Retain `runs.export-agent` for existing managed clients and add `runs.export-target` as the general operation.
An external call to the old operation returns an actionable unsupported-operation error.

## HTTP protocol

### Request

Each question and repetition produces one independent physical HTTP request.
The default JSON body is:

```json
{
  "question": "What was revenue last quarter?",
  "context": null,
  "answerFormat": null
}
```

Only the `PublicQuestion` projection and generated correlation identifiers can enter adapter input bindings.
Expected answers, evaluator code, reference rows, private criteria, and judge instructions never enter that projection.
The adapter cannot receive a complete bank question or Run manifest.

Use POST with `application/json` and one final JSON response.
A body template contains constants and existing slots replaced through JSON Pointer bindings.
Allowed sources are public question text, public context, public answer format, Run ID, question ID, repetition, and attempt ID.
Bindings preserve JSON types; no string interpolation, scripts, expressions, or implicit prompt construction occurs.
Reject overlapping bindings, missing destination slots, unsafe object keys, and excessive depth or size.
Provide the default mapping without requiring users to understand JSON Pointer.
Do not expose system prompt, model, tools, or arbitrary per-question environment inputs as special controls.
Static integration fields can identify the remote agent but are ordinary endpoint configuration.

Send no cookies and retain no remote conversation state between questions.
The endpoint must isolate requests or use the supplied attempt identifier for its own isolation.
The harness cannot prove that an arbitrary endpoint is stateless.
Stateful integration requirements belong in a wrapper endpoint or future dedicated adapter.

### Authentication and transport

Support no authentication, bearer token, and API key in a configured header.
Store authentication through the existing SecretStore and local workspace ownership rules.
Public configuration contains credential references only.
Reject credentials in URL user information, query parameters, and ordinary header fields.
Accept fixed non-secret query parameters when an integration requires them.
Reject conflicting authentication headers and transport-controlled headers such as Host and Content-Length.

Use HTTPS by default, with HTTP allowed only for loopback development endpoints.
Private network HTTPS endpoints are supported because the engine runs on the user's machine.
Reject URL schemes other than HTTP and HTTPS, fragments, and cross-origin redirects; the first release follows no redirects.
Keep TLS certificate verification enabled.
Browser requests go through the local engine and never receive endpoint credentials.
Native credential operations and remote requests remain bounded independently.

Default request deadline: 120 seconds, configurable from 1 second to 10 minutes.
Apply the deadline to connection establishment and complete response reading, with AbortSignal propagated through both.
Bound request bodies to 1 MiB and decoded response bodies to 4 MiB, subject to the existing stricter Run evidence limit.
Enforce limits while reading, not after buffering an unlimited body.
Default external concurrency to one; allow an explicit bounded setting up to the shared runtime capacity.
No implicit HTTP, rate-limit, authentication-refresh, or adapter retries occur.

### Response and answer extraction

A successful response has a 2xx status other than 202 or 204, valid JSON, and a selected answer value.
The default response is `{ "answer": "Returned answer" }`.
One JSON Pointer selects the answer; an empty pointer selects the complete JSON response.
Preserve strings, numbers, booleans, arrays, objects, and explicit null without coercion.
A missing pointer differs from a selected null.
Root JSON strings support text-only answers without a second response protocol.
No automatic Markdown stripping, JSON repair, fallback field search, or LLM answer extraction occurs.

A selected answer remains sealed exactly as received.
Evaluation applies explicitly supported representation policies before assessing public-format compatibility and answer content.
For example, an explicitly accepted JSON-encoded table must not become a false failure in an earlier transport validation step.
An answer that remains structurally invalid receives an explicit invalid-answer assessment.
It must count in reported evaluation coverage and cannot disappear as a transport error.
It receives no corrective target call.
Missing answer selection, invalid JSON, unsupported asynchronous responses, and response size violations are protocol failures with separate execution outcomes.
Non-2xx responses are transport failures, even when their body contains an `answer` property.
Existing deterministic evaluation defaults and explicit representation policies continue to apply after extraction.

## Evidence, judging, and lifecycle

Persist admission and dispatch intent before starting the physical request.
Record attempt ID, frozen target identity, request start and finish timestamps, outcome, HTTP status, bounded response evidence, and extracted answer.
Record adapter ID, adapter contract version, implementation build identity, and the declared observation level.
Keep request authentication, cookies, and sensitive headers out of artifacts, events, exports, and error messages.
Persist the public request body and safe transport metadata only.
Apply the existing evidence redaction policy before sealing; reject known credential leakage rather than silently grading a changed answer.
All response and error content is untrusted text in the UI.

Save external evidence with an explicit `answer-only` observation level.
LLM and Jev judges remain optional and receive the question, reference, and all available saved answer evidence.
Their instructions state that internal steps are unavailable; missing steps cannot establish that the target omitted a required action.
Criteria requiring internal execution evidence must abstain or be marked unsupported before launch.
Deterministic tool or trace checks are incompatible with answer-only targets and must not silently become false failures.
Existing answer-only deterministic checks continue to work unchanged.
Declare evidence requirements on evaluator and judge-profile revisions: answer evidence, internal activity, or unspecified.
Built-in answer comparisons declare answer evidence; custom code and free-form judge criteria default to unspecified until their author declares requirements.
Do not infer those requirements by inspecting arbitrary code or natural-language instructions.
External launch rejects unspecified or incompatible required deterministic evaluators with instructions to publish a compatible revision.
Optional judges require a compatible declared profile before launch.
Saved-evidence judging records unsupported evidence without a provider call.
Provide answer-focused default judge profiles for external targets, while keeping internal-evidence claims unavailable.
If required evidence unexpectedly disappears during execution, publish an unavailable or abstention outcome, never an incorrect-answer verdict.
Existing unspecified revisions and historical assessments remain unchanged; publishing a declaration creates a new revision.
Judging and rescoring never contact the endpoint again.

Keep local attempt outcome and remote completion certainty as separate facts.
A fully received valid response establishes observed completion.
Timeout, disconnect, engine death after dispatch intent, and local cancellation leave remote completion unknown.
An HTTP error does not prove that a remote side effect never occurred.
An attempt interrupted before dispatch is known not to have been sent.
Late responses after interruption cannot replace sealed outcomes.

Pause stops new admissions and drains active requests.
Halt and Cancel abort local requests, settle local resources, and preserve unknown remote completion explicitly.
Resume preserves completed results and creates fresh attempt IDs for unfinished work.
Resuming an external attempt with unknown completion requires an explicit duplicate-work acknowledgment in both CLI and UI.
No new acknowledgment is needed for work proven not dispatched.
Startup never silently resends uncertain external attempts.
The launch idempotency key prevents duplicate local Runs; it does not guarantee remote exactly-once execution.
The default protocol does not claim remote idempotency or retry safety from a correlation identifier.

## Architecture

### Target contracts

Introduce a discriminated `TargetConfig` at the Run boundary.
Keep `AgentConfig` for agents configured by the harness, including researchers and local judges.
Do not add fake model, prompt, or tool fields to an HTTP target.

```ts
// Proposed contract shape, not implementation.
type TargetConfig =
  | { kind: "managed"; agent: AgentConfig }
  | {
      kind: "external";
      adapterId: string;
      adapterVersion: number;
      configuration: Json;
    };
```

Each registered external adapter validates its concrete configuration schema; arbitrary adapter identifiers and unvalidated JSON are rejected.
The generic HTTP configuration includes the endpoint, mappings, credential reference, safe headers, and optional deployment label.
Target capabilities are derived from the registered adapter, not accepted as client claims.
Freeze the effective capabilities and target configuration alongside the Run manifest.

### Ownership

| Component                       | Responsibility                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Application Run service         | Target resolution, admission, limits, lifecycle intent, immutable attempts, evaluation, retry acknowledgment |
| External target catalog service | Named reusable configuration CRUD and snapshot resolution                                                    |
| Runtime target dispatcher       | Dispatch through the registered adapter selected by frozen target configuration                              |
| Managed target adapter          | Existing Codex/OpenCode process execution and tool integration                                               |
| HTTP target adapter             | Bounded transport, public request mapping, answer selection, safe transport evidence                         |
| Future Agentforce adapter       | Provider authentication, session lifecycle, response translation, session cleanup                            |
| Runtime credentials             | Secret references, resolution, replacement, deletion, and platform stores                                    |
| Evaluator and judges            | Assess sealed evidence with explicit evidence availability                                                   |
| React and CLI                   | Present and submit the same application contracts                                                            |

Place concrete target adapters under `src/runtime/targets/`, with a concrete registry at runtime composition.
Use separate focused modules for generic HTTP mapping and transport only where responsibilities warrant them.
Reserve `src/runtime/targets/agentforce/` as the documented location for a future adapter; create no empty implementation folder or stub.
Keep the adapter port in public runtime contracts and concrete imports out of application, evaluator, and React modules.

The shared target invocation contract accepts public input, limits, cancellation intent, and a constrained event sink.
It returns normalized answer evidence, local outcome, remote completion certainty, and cleanup status.
It has an explicit recovery operation for adapter-owned unfinished resources, driven by application startup policy.
An adapter can checkpoint private recovery metadata before remote resource creation, without publishing it as observation events.
Checkpoint writes use an application-provided persistence contract; adapters do not import SQLite or own product records.
HTTP needs no remote resource handles and reports uncertain dispatched requests without retrying them.
Provider-specific recovery metadata never becomes a second Run state machine.

Keep target admission independent of native process capacity.
HTTP invocations reserve shared target capacity without reserving Windows jobs or macOS process groups.
Local provider work still uses the shared ProcessSupervisor for native process ownership.
Keep secret availability and target adapter readiness independent of installed Codex/OpenCode discovery.
An external-only evaluation must not need a local model executable, model login, or unused local process-helper compilation.
Selecting local judging still requires that judge's own runtime readiness.
Native platform support remains Windows and macOS; this feature does not implicitly add Linux product support.

Use named external target records as editable catalog configuration, not an additional execution hierarchy.
Freeze their resolved settings directly into Runs and blueprints.
References to mutable catalog records cannot determine historical evaluation behavior.
Target credential management reuses SecretStore transaction patterns without misclassifying external targets as Tableau tool connections.

### Capability-driven presentation

Keep a small explicit capability contract: target configuration ownership, observation level, cancellation guarantee, research mutation support, and export scope.
Existing managed adapters keep their current capabilities.
Generic HTTP declares external configuration ownership, answer-only observation, unconfirmed remote cancellation, no mutation, and endpoint-only export.
The application validates these capabilities and supplies the UI's effective setup sections.
Do not scatter checks such as `adapterId === "agentforce"` across setup, lifecycle, observation, and results.
An adapter-specific settings component is acceptable; provider-specific Run or Results pages are not.

### Maintainer extension contract

This is an internal development contract, not an end-user extensibility feature.
Ship the registry, adapter contract, capability handling, recovery boundary, and shared UI integration with the HTTP implementation.
Documentation alone or an empty adapter directory does not satisfy this requirement.

Adding a supported runtime follows this established checklist:

1. Add a concrete adapter under `src/runtime/targets/<runtime>/` and register it in runtime composition.
2. Define its validated configuration schema, credential requirements, supported capabilities, and configuration version migration.
3. Implement invocation, response normalization, cancellation reporting, resource cleanup, and recovery using the shared contracts.
4. Add a focused settings component only where provider-specific configuration needs one.
5. Run the shared adapter contract suite and add provider protocol fixtures and bounded integration checks.
6. Document provider requirements and expose the integration through the existing target selector.

Run scheduling, attempt persistence, evidence sealing, evaluation, observation, results, blueprint reuse, and exports remain shared responsibilities.
A routine runtime integration must not require a new Run lifecycle, evidence format, navigation hierarchy, or evaluator path.
Provider research still determines authentication, API eligibility, session behavior, and actual cancellation guarantees.
A genuinely new capability can require an explicit contract revision; do not encode speculative capabilities in advance.
End users cannot upload adapter code, install runtime plugins, edit the registry, or define lifecycle scripts.

### Agentforce extension seam

Salesforce's Agent API uses session creation, messages within that session, and session termination.
That lifecycle justifies a dedicated adapter rather than adding authentication and workflow scripting to the generic HTTP editor.
The API supports synchronous message responses, which suit the proposed normalized answer boundary.
These facts come from Salesforce's [session lifecycle documentation](https://developer.salesforce.com/docs/ai/agentforce/guide/agent-api-lifecycle.html) and [API reference](https://developer.salesforce.com/docs/ai/agentforce/references/agent-api).

A future Agentforce adapter owns authentication, fresh per-attempt sessions, message sequencing, remote identifiers, and best-effort session cleanup.
The application still owns attempt admission, limits, outcome publication, and recovery policy.
Session termination must not be advertised as confirmed cancellation of all remote work without provider-specific proof.
An answer and session cleanup failure remain separate facts, so cleanup cannot erase received evidence.
Eligibility, authentication requirements, API versions, permissions, and cancellation semantics require verification during that adapter's own specification.
No Salesforce internal trace display, deployment editing, prompt editing, or research mutation is implied by adding the adapter.

## Compatibility and migration

Version new launch contracts, Run manifests, evidence envelopes, blueprints, and exports explicitly where their shape changes.
New Runs store `target`; avoid permanently storing both `agent` and `target` representations.
Read previous immutable manifests through a single versioned decoder that interprets their agent as a managed target.
Never rewrite historical evidence or manifest bytes to perform that conversion; preserve existing hashes and digests.
Migrate mutable blueprint and draft storage transactionally, including browser draft versioning.
Keep a documented bounded compatibility decoder for existing CLI launch payloads, rejecting mixed `agent` and `target` inputs.
New discovery schemas and UI use only the new canonical launch shape.

Audit every target assumption in launch, execution, research, judging, result summaries, draft restoration, and export.
Research accepts managed targets only in this release; local judge configuration continues to use AgentConfig.
Remove superseded target-specific wiring after consumers move to the shared contracts.
Update the build charter and acceptance criteria when implementation is approved, distinguishing local cleanup guarantees from remote uncertainty.

## Implementation plan

Recommend tests before behavior changes and an independent architecture review after integration.
The build proceeds through these reviewable stages:

1. **Contract and compatibility design.**
   Add target, capabilities, evidence availability, and remote completion contracts with fixtures for old manifests and CLI payloads.
   Define explicit result accounting for protocol errors versus invalid selected answers.
   Gate: old artifact bytes and managed exports remain unchanged; new external inputs reject managed-only fields.
2. **Unify target invocation.**
   Extract managed execution behind the target dispatcher, separate target admission from process admission, and scope runtime readiness to selected operations.
   Keep judge and researcher configuration independent from target selection.
   Gate: existing local workflows pass without alternate application lifecycle branches, and the internal adapter contract is implemented for maintainers.
3. **Add endpoint catalog and credentials.**
   Implement reusable configuration, immutable resolution, credential binding, replacement recovery, and safe previews.
   Gate: copies, deletion, edits, and exports cannot expose credentials or alter saved Runs.
4. **Implement generic HTTP invocation.**
   Add strict mappings, bounded transport, protocol errors, dispatch checkpoints, local cancellation, and remote uncertainty handling.
   Gate: deterministic local HTTP fixtures cover lifecycle behavior without paid or live agent calls.
5. **Integrate evaluation and saved evidence.**
   Seal answer-only evidence, enforce evaluator compatibility, and update optional judge evidence instructions and result accounting.
   Gate: grading, previews, rescoring, and blueprint reuse never invoke the external target unexpectedly.
6. **Adapt the UI and CLI.**
   Build target-first setup, external agent settings, request observation, contextual help, comparison labels, and target export.
   Gate: a user can configure, sample, launch, pause, halt, resume, review, reuse, and export through either interface.
7. **Review and document.**
   Run Windows and macOS checks, browser acceptance, existing managed regressions, and adversarial architecture review.
   Publish endpoint examples, mapping guidance, cancellation semantics, compatibility notes, and the future adapter checklist.
   Gate: remove obsolete wiring, preserve historical evidence, and demonstrate one Run lifecycle for both target types.

Agentforce implementation is a separate future build after this plan, not an eighth stage hidden in the HTTP release.

## Acceptance matrix

| Area                  | Required evidence                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Public input boundary | Deliberately tagged golds and private criteria cannot appear in serialized requests or previews                                               |
| Mapping               | Nested values, escaped pointers, null, false, zero, empty strings, missing fields, overlap, and type preservation                             |
| HTTP                  | Success, 202, 204, non-2xx, invalid JSON, truncated bodies, response limits, redirects, TLS failure, and slow body reads                      |
| Authentication        | Bearer and API-key fixtures; no credential disclosure in artifacts, events, previews, exports, or errors                                      |
| Isolation             | Separate attempt identifiers, no cookies or shared conversation, independent repetitions                                                      |
| Lifecycle             | Pause drain, queued halt, active halt, cancel, dispatch crash window, late response, uncertain Resume acknowledgment, and no implicit retry   |
| Evaluation            | Text and structured answers, invalid public format, unsupported trace checks, optional judge abstention, and unchanged deterministic defaults |
| Saved evidence        | Offline rescore and judge preview, frozen blueprint restoration, export, missing credentials, and edited catalog configuration                |
| Managed compatibility | Existing Codex/OpenCode runs, tools, research, local judging, and old manifest digests                                                        |
| Architecture          | No native process dependency for HTTP, no private evaluation input in adapter ports, and no provider-specific lifecycle in the application    |
| UI                    | Required sections, help hover/click, keyboard access, narrow layout, no irrelevant controls, and honest unknown telemetry                     |
| Future adapter seam   | A test-only session adapter demonstrates create/invoke/cleanup/recovery through the same application lifecycle                                |

The future adapter fixture proves that maintainers can register a session-based runtime without changing Run orchestration, evaluation, or shared observation.
It exercises the implemented boundary without shipping an Agentforce stub or a general workflow framework.
No real external request is required for the initial protocol tests.
An explicitly selected endpoint can provide the final bounded integration check during the approved build.
