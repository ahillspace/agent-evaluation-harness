# macOS support

Shared macOS process and secret-store implementations exist.
Authenticated native Mac acceptance remains a release requirement.
The runtime supports cooperative providers and does not claim Windows-equivalent descendant containment.

This page owns current platform guarantees and acceptance limits.
[Runtime contracts](runtime.md) owns shared provider, credential, and cleanup workflows.
The earlier platform implementation plan is superseded by the implemented boundaries below.

## Platform composition

[createPlatformServices](../src/runtime/platform.ts) selects `WindowsProcessDriver` and DPAPI, or `PosixProcessDriver` and Keychain.
Provider adapters use shared coordination without importing concrete platform infrastructure.
[Architecture checks](../scripts/architecture-check.mjs) enforce process, credential, connection, and provider dependency boundaries.

| Concern              | Windows                                                | macOS                                                                          |
| -------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Process ownership    | Job Objects and named durable scope records.           | Independent watchdog, retained group leader, and durable identity records.     |
| Descendant limit     | Native active-process limit and job containment.       | No hard descendant ceiling; providers must not detach.                         |
| Recovery             | Verify and drain named jobs before releasing capacity. | Verify identity and group membership before signaling or declaring settlement. |
| Credential storage   | Current-user DPAPI with local encrypted files.         | Dedicated login Keychain service through bounded `security` requests.          |
| Native prerequisites | System .NET Framework compiler prepares the helper.    | Built-in `security` and `ps` utilities; no runtime helper compilation.         |

Other operating systems reject local process-driver and credential-store operations.
Portable tests and HTTP-only paths do not establish Linux product support.
Installers, desktop shells, automatic updates, and a minimum supported macOS version are not established by this implementation.

## Managed process guarantees

[PosixProcessDriver](../src/runtime/processes/posix.ts) writes an initial lease before launching the watchdog.
[posix-watchdog](../src/runtime/processes/posix-watchdog.ts) records its identity and the runner identity before admitting target work.
[posix-runner](../src/runtime/processes/posix-runner.ts) retains its group-leader identity after the direct target exits.
Engine IPC loss requests cleanup independently of the original provider process.

[posix-state](../src/runtime/processes/posix-state.ts) owns process inspection and bounded group cleanup.
`verifyOwner` checks start identity, user identity, entry-point path, and scope ID.
`inspectGroup` distinguishes empty, live, and zombie-only membership.
Permission denial or missing inventory does not prove settlement.
`drainGroup` permits zombie settlement only with current ownership or continuity established during that cleanup.
Conflicting identities and unverified cleanup retain scope records and block new process admission.

Cancellation requests graceful termination and bounded escalation.
A frozen watchdog has a separate stop and recovery path.
The shared supervisor waits for cleanup before releasing capacity.
These mechanisms cover providers that preserve ownership, not hostile processes that deliberately detach or change ownership.

[Process fixtures](../src/runtime/processes/posix.test.ts) cover cancellation, direct-child exit, engine IPC loss, frozen watchdog recovery, output bounds, and unrelated-process rejection.
[State tests](../src/runtime/processes/posix-state.test.ts) cover Darwin inventory gaps, identity conflicts, zombie continuity, and unowned members.
Fixture tests are not proof of arbitrary provider containment.

## Keychain and workspace ownership

[KeychainSecretStore](../src/runtime/secrets/keychain.ts) uses `com.agent-evaluation-harness.credentials.v1`.
Secret-bearing writes use encoded standard input rather than process arguments.
Writes verify their stored value and reject interactive command input above 4095 bytes.
[runSecretCommand](../src/runtime/secrets/native-command.ts) limits requests to 10 seconds and 256 KiB combined output.
Denied access, locked stores, missing values, and unavailable utilities return sanitized recovery instructions.
No plaintext fallback exists.

[WorkspaceSecretScope](../src/runtime/secrets/scope.ts) binds opaque references to machine-local registration and canonical workspace location.
Copied or moved workspaces require credential entry again.
They cannot read or delete the source workspace's Keychain entries.
Connection replacement and deletion use the same recoverable journal workflow on both platforms.
Legacy Windows ciphertext import on Mac retains public metadata without migrating usable authentication.

[Credential tests](../src/runtime/secrets/secrets.test.ts) exercise encoding, ownership, native failures, and write verification.
Actual Keychain prompts, account permissions, and headless interaction need native acceptance.

## Provider compatibility

[Executable resolution](../src/runtime/commands.ts) validates executable files and preserves argument boundaries without a command shell.
MCP supports explicit executable paths; installed CLIs otherwise resolve through the engine's PATH.
The inherited environment includes `TMPDIR`, selected XDG locations, account configuration, and `NODE_EXTRA_CA_CERTS`.
It excludes unrelated host credentials and TLS-disable variables.

Provider sign-in remains machine-local and separate from stored connection credentials.
Native acceptance must cover installed Codex, Claude, OpenCode, Bedrock bridges, and the configured Tableau MCP launch.
Portable command fixtures cannot establish actual Mac CLI isolation, authentication, session continuity, or company certificate behavior.

## Validation and release limits

The [local pre-push gate](architecture.md#build-tooling-and-change-placement) runs validation on the pushing machine.
No hosted operating-system or Node.js matrix runs automatically.
A local Windows pass does not establish macOS acceptance.
The [runtime reliability review](runtime-review-2026-10-09.md) records earlier macOS fixture failures and subsequent local regression scope.
The [HTTP verification record](http-target-verification.md) separately records historical Windows and Linux checks.
Those dated records do not certify the current working tree.

Native release acceptance needs recorded results for these operations:

- Run process fixtures on both Mac architectures, including crash recovery, cancellation, watchdog failure, and unresolved ownership.
- Store, replace, read, and delete Keychain credentials, including denied access and copied workspaces.
- Discover installed providers and run bounded authenticated targets with selected MCP tools and typed submission.
- Resume exact researcher conversations and inspect independent judge evidence.
- Verify browser observation and controls, CLI parity, workspace locking, artifact writes, and custom evaluation.
- Run the repository's required formatting, architecture, type, lint, test, and build checks.

Use approved low-cost or free models for provider validation; Astra is excluded from validation runs.
Record tested macOS versions and architecture-specific behavior before claiming a minimum supported macOS version.
This documentation audit does not perform authenticated native Mac acceptance.
