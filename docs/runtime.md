# Runtime contracts

The runtime implements `RuntimePort` for the shared application layer.
The CLI and HTTP server never start provider processes directly.

## Run a target

`resolveAgent` validates supported harness settings, freezes public connection settings, and records whether authentication uses a local account or an explicit credential connection.
An explicit model connection must match the selected model provider.
Ambient API keys are not an implicit fallback.
Exported agent configurations include the resolved settings and credential field placeholders.
Credentials remain behind an independent `SecretStore` contract.
Windows uses Data Protection API for the current account; macOS uses the login Keychain.

Codex uses its installed CLI, strict configuration validation, and a replacement instructions file containing the configured system prompt.
Its target task includes the typed answer submission protocol required by code mode.
OpenCode uses an isolated configuration with external plugins disabled.
Both harnesses deny default host tools and expose only the selected MCP tools and `submit_answer`.
The submission server accepts one JSON answer and rejects overwrites.

`maxTurns` limits completed tool calls in both adapters.
OpenCode also applies this value to its native agent step limit.
Timeouts cover credential and process admission waits, provider execution, and interruption requests.
Cleanup completes before an invocation settles, even when that takes longer than the requested timeout.

## Own provider processes

Runtime composition selects Windows or macOS infrastructure while provider adapters use one shared invocation workflow.
Other operating systems reject live runtime recovery before starting provider work.
The application, evaluator, transport, and protocol tests run independently of native infrastructure.
Native Mac acceptance remains pending until Keychain, provider authentication, and lifecycle checks run on real Macs.

`ProcessSupervisor` coordinates invocation capacity, output limits, deadlines, cancellation, and shutdown through a `ProcessDriver` contract.
The Windows driver creates the target suspended, assigns it to a Job Object, applies an active process limit, and resumes it.
The job contains descendants and terminates them when the owning engine exits.
Windows cleanup verifies that the named job has no active processes before releasing capacity.
The macOS driver uses an independent watchdog and a retained process-group leader for cooperative, non-detaching providers.
It records ownership before admitting target work and checks process identity before recovery signals.
Managed process groups do not provide a hard descendant limit or containment of processes that deliberately detach.
Invocation capacity is shared scheduling policy; only Windows enforces a hard per-scope descendant ceiling.
Startup reconciles durable scope records before admitting work.
Cleanup failures retain capacity and stop further admissions.
Shutdown awaits admitted invocations that have not spawned yet.

Tableau PAT sessions sharing a server and credential serialize across connection aliases.
Connection probes use the same guard as target invocations.
Independent credentials can run concurrently within invocation capacity.
The runtime starts local MCP processes and does not provide a container execution mode.
Custom MCP launch commands must preserve local process ownership rather than create detached services or containers.

## Store connection credentials

Connection records contain opaque references rather than credential values or platform ciphertext.
A machine-local registration binds those references to the canonical workspace location.
Registration and Windows encrypted files live under the current user's `.agent-evaluation-harness/credentials` directory.
Mac credentials use the dedicated `com.agent-evaluation-harness.credentials.v1` Keychain service.
Copied or moved workspaces retain public connection settings but require credential entry again.
They cannot read or delete credentials belonging to the source workspace.

Replacement records a cleanup intent before creating a new secret, atomically adopts its reference, and then retires the previous secret.
Startup retries unfinished cleanup; a failed cleanup retains its durable intent and reports the failure.
Deletion removes the connection reference before retiring its secret through the same journal.
An isolated startup migration converts earlier Windows ciphertext records without placing legacy handling in ordinary connection operations.
Importing those earlier records on Mac retains public settings and requires credential entry.

Native credential requests have a 10-second timeout and bounded output.
Credential-bearing input uses standard input, never process arguments.
The Keychain adapter encodes values, limits interactive commands to 4095 bytes, and verifies stored values after writing.
Denied, locked, missing, or unavailable credentials produce sanitized recovery instructions; plaintext fallback is not supported.
Unlock the login Keychain and grant access when required before retrying a headless operation.

## Inspect models and connections

Codex discovery uses the installed app server's account and model catalog methods.
OpenCode discovery uses its installed model and authentication commands.
A catalog entry does not guarantee that the current account can run that model.
Model credential connections support OpenAI, Anthropic, and OpenRouter API keys.
Testing these connections authenticates a model catalog request and returns the provider's model IDs.
Testing Tableau authenticates to the selected site, signs out of the probe session, and discovers the installed MCP tool schemas.
No model inference is required for discovery.

## Preserve research and judging boundaries

Research uses one provider conversation ID and rejects a different ID during resume.
The runtime publishes the ID immediately so the application can checkpoint it before interruption.
The researcher reads evidence through a dedicated MCP tool and a temporary authenticated loopback endpoint.
The application authorizes each evidence request and audits explicit gold retrieval.
Research conversations persist in the provider's own session storage.

Codex reports cumulative conversation token counters for resumed research.
Research results mark those counters with `usageScope: conversation` so the application counts the latest total once.
OpenCode reports usage for the current turn.
Unavailable token or cost values remain unavailable instead of becoming zero.
The independent judge receives only the supplied question, expected answer, answer, and instructions, with no connection tools.

## Add an adapter

The following requirements describe the existing local harness extension path.
See [external evaluation targets](external-targets.md) for deferred HTTP targets and first-class remote runtime adapters.

A new harness adds discovery, isolated command construction, event normalization, explicit answer submission, and conversation continuity where supported.
It must run through the existing supervisor and pass the lifecycle and protocol tests.
A new connection provider adds settings validation, public snapshot resolution, credential fields, a connection probe, and MCP environment construction.
The engine must not acquire provider-specific query or authentication logic.
A new platform supplies process ownership and secret storage implementations through runtime composition and passes the shared lifecycle contracts.
Its documented guarantees must distinguish managed cleanup from hard containment and include native crash, recovery, and credential tests.
See [macOS support](macos-support.md) for the portability specification, implementation plan, and acceptance evidence.
