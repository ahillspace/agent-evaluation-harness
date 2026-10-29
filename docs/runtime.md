# Runtime contracts

The runtime implements `RuntimePort` for the shared application layer.
The CLI and HTTP server call application operations rather than starting providers directly.
[LocalRuntime](../src/runtime/index.ts), constructed by `createRuntime`, registers managed and HTTP target adapters.

Use [external targets](external-targets.md) for target ownership, [HTTP setup](http-targets.md) for endpoint configuration, and [adapter development](target-adapters.md) for extension requirements.
[macOS support](macos-support.md) owns platform guarantees and native acceptance limits.

## Composition and readiness

`LocalRuntime` composes `TargetRegistry`, `ProcessSupervisor`, `ConnectionService`, `ExternalTargetCatalog`, and `JevClassifier`.
[createPlatformServices](../src/runtime/platform.ts) selects process drivers and secret stores.
Provider adapters do not select operating systems.

| Operation       | Runtime path                                         | Process requirement                                               |
| --------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| Managed target  | `ManagedTargetAdapter` → `executeManaged` → `invoke` | CLI scopes or Bedrock MCP bridge scopes.                          |
| HTTP target     | `HttpTargetAdapter` → `executeHttpTarget`            | None for transport; authentication needs a platform secret store. |
| Research        | `researcher` → `invoke`                              | CLI scopes or a Bedrock evidence MCP bridge.                      |
| LLM judge       | `judge` → `invoke`                                   | CLI scopes; Bedrock calls Converse after local readiness.         |
| Jev             | `JevClassifier.evaluate` → `jevHttp`                 | No harness process.                                               |
| Discovery       | `discover` → `discoverHarness`                       | Installed CLI probes, plus a built-in Bedrock entry.              |
| Tableau catalog | `listConnectionResources` → `queryTableauResources`  | REST only; MCP tool discovery separately starts a process.        |

`recover` initializes connection migration, external credential cleanup, persisted process scopes when present, and abandoned MCP resources.
`ensureLocal` lazily recovers native infrastructure before discovery, managed invocation, or `testConnection`.
HTTP-only operation avoids installed harness discovery and unused process-helper compilation.
This separation does not establish Linux product support.

[createApplication](../src/application/application.ts) acquires workspace ownership before runtime and application recovery.
[TargetInvocations](../src/application/target-invocations.ts) persists private adapter checkpoints separately from immutable evidence.
[RunService](../src/application/runs.ts) owns Run controls, interruption status, and product admission policy.

## Managed providers

`resolveAgent` validates harness settings, public connection snapshots, and model-provider compatibility.
It permits at most one model credential connection matching the selected provider.
Bedrock requires a saved bearer connection.
Other harnesses can use their local account when no model connection is selected.
Ambient API keys are excluded from inherited provider environments.

| Harness  | Invocation and isolation                                                                                                                                      | Discovery and compatibility limit                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Codex    | `buildHarnessCommand` uses strict configuration, ignored user settings and rules, replacement instructions, read-only sandboxing, and disabled host features. | Installed app-server account and paginated model catalogs; execution needs the implemented CLI flags.        |
| Claude   | `claudeCommand` uses restricted mode, no built-in tools, strict MCP configuration, disabled hooks, replacement instructions, and an allowlist.                | Discovery requires Claude Code 2.1.248 or newer and reads authentication status without inventing model IDs. |
| OpenCode | `buildHarnessCommand` uses pure mode, isolated configuration, disabled sharing and updates, denied default tools, and configured MCP permissions.             | Installed model and authentication commands; catalog presence does not prove account eligibility.            |
| Bedrock  | `invokeBedrock` sends non-streaming Converse requests with bearer authentication and tools through supervised MCP sessions.                                   | No CLI requirement; connection testing validates settings without invoking a model or verifying credentials. |

Implementation owners are [harness construction](../src/runtime/harness.ts), [Claude translation](../src/runtime/claude.ts), [Bedrock invocation](../src/runtime/bedrock.ts), and [discovery](../src/runtime/discovery.ts).
Installed CLI behavior, authentication, model availability, and gateways require bounded integration checks.
Fixture coverage does not establish compatibility with every provider version.

`createHarnessBridges` adds configured connection tools and `submit_answer` for targets, or `read_evidence` for researchers.
[mcp-host](../src/runtime/mcp-host.ts) implements submission and evidence tools and forwards connection traffic within supervised ownership.
The submission bridge validates public answer structure before creating an exclusive answer file.
Invalid structure returns corrective feedback without recording an answer.
Later submissions receive an immutable-answer receipt.
`executeManaged` requires that submission rather than treating provider prose as the answer.
Provider failures preserve available normalized partial evidence and usage.

`maxTurns` is not a uniform conversation-turn metric.
The CLI path counts normalized `tool.completed` events; Claude also receives native `--max-turns`, and OpenCode receives its native step limit.
Bedrock separately bounds model iterations and individual tool calls.
[withInvocationDeadline](../src/runtime/deadline.ts) includes admission waits and provider work.
Cleanup settles before invocation completion, even when it extends beyond the deadline.

## Process ownership

[ProcessSupervisor](../src/runtime/process-supervisor.ts) owns invocation permits, output bounds, cancellation, deadlines, and shutdown through `ProcessDriver`.
Each permit owns a copied plan of 1 to 21 process scopes, with an explicit descendant limit for each scope.
Bedrock admits its complete bridge plan before starting any bridge and never reacquires a permit for its children.
Concurrency counts invocations rather than operating-system processes.
One invocation can therefore run multiple bridges at concurrency one.
The target registry separately admits managed and process-free HTTP invocations.
The aggregate process bound depends on concurrent plans, scopes per plan, and native descendant limits.

The [Windows driver](../src/runtime/processes/windows.ts) persists named scope records and uses the [Job Object helper](../src/runtime/windows-job.ts).
The helper launches suspended work, assigns the job and descendant limit, and resumes work.
Cleanup verifies the job before deleting its record.
Initial native readiness compiles the helper with the system .NET Framework compiler.

The [macOS driver](../src/runtime/processes/posix.ts) uses a watchdog, retained process-group leader, and durable identity records.
Recovery verifies owner identity before signaling.
Only Windows advertises hard descendant containment; macOS supports cooperative providers that preserve process ownership.

The supervisor bounds combined stdout and stderr.
Its default is 4 MiB; managed CLI invocation supplies 4,000,000 bytes unless overridden.
Overflow stops the scope rather than extending an unbounded line buffer.
Callback errors, cancellation, process exit, and timeout still pass through cleanup.
Unverified cleanup retains the invocation permit, closes process admission, and returns `cleanup_failed`.
Cancellation before process launch releases admission without claiming a cleanup failure.
Shutdown awaits admitted work that has not spawned.

[prepareMcpBindings](../src/runtime/mcp-resources.ts) creates parent-owned modules for Tableau feature overrides.
The modules merge installed package defaults with explicit overrides.
Confirmed cleanup removes resources; unresolved process cleanup leaves them for recovery.
Startup removes abandoned resource directories after process recovery.

## Connections and credentials

[ConnectionService](../src/runtime/connections.ts) owns settings validation, public binding snapshots, credential resolution, and provider environments.
[model-providers](../src/runtime/model-providers.ts) supports OpenAI, Anthropic, OpenRouter, and Bedrock credential translation.
The first three use inference-free model catalog probes.
[Model catalog discovery](../src/runtime/model-catalog.ts) bounds the complete operation to 20 seconds, 8 MiB of decoded responses, 20 pages, and 10,000 models.
Anthropic cursors stay on the configured endpoint; other catalogs reject unsupported continuation explicitly.
Invalid, oversized, interrupted, or incomplete discovery returns a failed status and no partial catalog.
Bedrock testing explicitly reports unverified credentials and unavailable model discovery.

Connection records contain opaque references.
[WorkspaceSecretScope](../src/runtime/secrets/scope.ts) binds them to machine-local registration and a canonical workspace location.
Copied or moved workspaces require credential re-entry and cannot read or delete the source workspace's secrets.
[ConnectionStorage](../src/runtime/connection-storage.ts) journals replacement and deletion.
Replacement stages a new secret, adopts its reference atomically, and retires unretained old versions.
Failed cleanup retains its intent for startup recovery.
[Connection migration](../src/runtime/connection-migration.ts) isolates legacy Windows ciphertext conversion.
On macOS, legacy import preserves public metadata without usable credentials.

Managed bindings freeze validated settings, canonical provider/endpoint identity, and an opaque credential version.
`resolveCredentials` verifies identity and machine-local ownership without reading today's catalog credential.
Frozen versions survive rotation and catalog deletion for the workspace lifetime.
Targets, researchers, LLM judges, Jev, and redaction use the same strict resolver.
Ordinary connection probes capture settings and credentials together without permanent retention.
Legacy frozen bindings require explicit compatible reuse with locally entered credentials; stored evidence is not rewritten.
Configuration exports omit retained references and use credential placeholders.
HTTP snapshots retain their [external credential contract](external-targets.md#credential-ownership).

[Native secret commands](../src/runtime/secrets/native-command.ts) use standard input, a 10-second timeout, and 256 KiB combined output.
[Windows secrets](../src/runtime/secrets/windows.ts) use current-user DPAPI and local encrypted files.
[Keychain secrets](../src/runtime/secrets/keychain.ts) use the dedicated `com.agent-evaluation-harness.credentials.v1` service.
Keychain writes encode values, cap interactive input at 4095 bytes, and verify the stored result.
Credential failures return sanitized instructions without plaintext fallback.

[commands](../src/runtime/commands.ts) inherits a small environment allowlist, including account locations and `NODE_EXTRA_CA_CERTS`.
It excludes unrelated host API keys and TLS-disable variables.
Provider output redaction covers selected known credentials and their JSON-escaped forms, not arbitrary secrets in user text.
Custom MCP launch commands remain trusted local code and must preserve process ownership.

## Tableau integration

Tableau connections default to `npx -y @tableau/mcp-server@4.13.3`.
Settings support an explicit command, arguments, additional non-secret environment variables, and feature overrides.
Validation rejects managed overrides, case-insensitive duplicates, NUL values, and common credential-bearing names.
The runtime sets PAT authentication, stdio transport, tool selection, disabled telemetry, and enabled log masking.

[ConnectionGate](../src/runtime/connection-gate.ts) serializes the same normalized server and PAT value across connection aliases.
Managed invocations, probes, and REST discovery share the guard.
Waiting emits one event, remains cancellable, and starts no provider process before acquisition.
Independent credentials can proceed within capacity.
The guard coordinates one runtime instance rather than other apps or machines.

[withTableauSession](../src/runtime/tableau-connection.ts) signs in through REST API 3.22 and attempts sign-out after an operation.
Sign-out has a separate 10-second deadline, including after operation failure.
Cleanup failure remains explicit and preserves the operation error code when both fail.
Malformed sign-in data without a usable token cannot establish a cleanable session.

`queryTableauResources` requests bounded datasource pages with name sorting and exact-name search.
It rejects commas and ampersands in search before contacting Tableau.
It preserves IDs, names, projects, totals, and the next page.
Sign-in JSON has a 64 KiB limit; datasource JSON has a 4 MiB limit and fatal UTF-8 decoding.
Connection testing checks REST authentication, then MCP initialization and a tool-list response.
The MCP probe does not paginate its tool catalog.

The package pin, feature-provider entry-point layout, REST availability, permissions, and live data remain external compatibility boundaries.
The [runtime reliability record](runtime-review-2026-10-09.md) describes an earlier package fixture, not current authenticated deployment acceptance.

## Research and judges

`LocalRuntime.researcher` removes Tableau connections and exposes the evidence bridge.
Its temporary loopback endpoint requires a per-turn bearer token and strict request schema.
The application authorizes requests and audits explicit gold retrieval.
The runtime reports conversation identity immediately and rejects changed identities.
CLI providers retain research conversations in provider storage.
Bedrock saves local conversation state with a configuration fingerprint and pending-request marker.
Changed settings, missing state, or an unresolved request prevent Bedrock continuity.

Codex research reports cumulative conversation usage; other harnesses report turn usage.
[HarnessUsage](../src/runtime/usage.ts) normalizes cache and reasoning components without double counting.
[UsageProjection](../src/application/usage-projection.ts) accepts display breakdowns only when they match sealed inclusive totals.
Unknown values remain unknown.

`LocalRuntime.judge` strips Tableau tools and treats supplied evidence as data.
It saves request provenance before invocation and provider output before verdict parsing.
Invalid output raises `JudgeFailure` with recorded invocation evidence.
[LLM judge application handling](../src/application/llm-judge.ts) supplies sealed evidence without another target call.

[JevClassifier](../src/runtime/jev.ts) uses the official TypeSafe endpoint and a pinned model.
It rejects requests exceeding a 2 MiB memory guard without truncation.
[jevHttp](../src/runtime/jev-http.ts) bounds responses to 1 MiB by default and preserves safe requests, responses, request IDs, and reported usage.
Only explicit HTTP 429 or 529 rejections receive retries.
The primary call permits at most three attempts; an enabled answer-only fallback permits one attempt.
The application owns fallback eligibility, frozen criteria, publication, and the assessment deadline.
Classifier shutdown interrupts and drains admitted HTTP work.

## Verification boundaries

[Command tests](../src/runtime/harness.test.ts), [Bedrock fixtures](../src/runtime/bedrock.test.ts), and [cleanup redaction tests](../src/runtime/process-cleanup-redaction.test.ts) cover provider translation and failures.
[Process tests](../src/runtime/process-supervisor.test.ts) and [POSIX fixtures](../src/runtime/processes/posix.test.ts) cover process ownership.
[Credential tests](../src/runtime/connections.test.ts) cover replacement recovery and copied workspaces.
[Tableau tests](../src/runtime/tableau-connection.test.ts) cover paging, malformed metadata, and sign-out failures.
[HTTP acceptance](../tests/acceptance/http-target.test.ts) traces the application, server, and CLI.

These references identify test coverage without asserting that every check ran during this documentation audit.
Native macOS, interactive Keychain, authenticated provider accounts, company certificates, and live Tableau compatibility need separate recorded acceptance.
