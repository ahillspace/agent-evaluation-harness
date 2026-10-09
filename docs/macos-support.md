# macOS support plan

Status: **Implemented; authenticated Mac acceptance remains a release gate.**
The implementation target uses shared runtime coordination, independent secret storage, Windows Job Objects, and managed macOS process groups.
macOS supports providers that preserve process ownership and does not claim Windows-equivalent hard descendant containment.
Unverified cleanup blocks further admissions on either platform.

## Scope

Support the browser interface and headless CLI through the existing engine on macOS while retaining Windows support.
Preserve question banks, evaluation, observation, run controls, research, connection discovery, and independent judging.
Target native Apple Silicon and Intel support, with both architectures configured in CI.
Select the minimum macOS version after checking dependencies and testing on real Macs.
Keep installers, desktop shells, Tauri, automatic updates, Linux support, and external evaluation targets outside this work.
Retain the current npm launch workflow, workspace location, and Node.js 22.13.0 minimum while validating supported Node versions on macOS.
Do not introduce an app-directory migration as part of platform support.

## Starting constraints

The previous `ProcessSupervisor` combined invocation coordination, Windows Job Object ownership, helper compilation, and DPAPI credential encryption.
It rejected non-Windows platforms before admitting provider work.
Windows jobs enforce descendant counts and cleanup when the engine exits.
Previous connection records contained ciphertext protected for the current Windows account.
Provider discovery, target execution, research, and local judging share this supervisor.
The engine, evaluator, transport, and storage need no separate macOS implementations.

## Architecture

Design the runtime as if Windows and macOS were original requirements.
Replace existing infrastructure where its responsibilities conflict with that design.
Preserve product behavior and saved evidence without preserving every current class or internal interface.
Both platforms must use the same connection, invocation, and recovery workflows.
Platform implementations supply operating-system mechanics through focused internal contracts.

Keep platform selection inside runtime composition, below `RuntimePort`.
Application services retain lifecycle decisions; the CLI and browser retain their existing engine contracts.
Extract two focused boundaries: secret storage and owned process scopes.
Keep provider adapters independent of operating-system selection.

### Responsibility map

| Component                  | Responsibility                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------- |
| Runtime composition        | Select platform implementations once and inject dependencies.                         |
| Connection service         | Validate connection settings and coordinate credential replacement and deletion.      |
| Secret store               | Persist and retrieve secrets through the selected operating-system mechanism.         |
| Shared process coordinator | Own admission, deadlines, output bounds, interruption coordination, and shutdown.     |
| Platform process driver    | Own process identity, launch, termination, native helpers, and recovery verification. |
| Provider adapters          | Translate provider commands and responses through shared invocation contracts.        |
| Executable resolution      | Resolve validated commands independently of process supervision.                      |

Keep infrastructure contracts private to runtime rather than expanding public product contracts with operating-system details.
Use concrete composition and focused modules without a plugin framework, service locator, or platform-specific product workflows.
The final structure must contain one shared coordinator and one active composition path for each supported platform.

### Secret storage

Introduce a `SecretStore` contract for reading, replacing, and deleting connection secrets.
Separate it from process supervision.
Retain a Windows DPAPI implementation and use macOS Keychain for Mac credentials.
Recommend one Keychain item per workspace connection, with opaque references in public connection storage.
Use a versioned storage format and define Windows ciphertext compatibility explicitly during implementation.
Preserve existing connection access through a bounded migration rather than retaining two permanent credential paths.
Copying a workspace between machines does not transfer usable credentials; require credential entry on the destination.
Preserve copied run evidence; Windows DPAPI ciphertext remains unusable on Mac, and provider account sign-in remains machine-local.

Make replacement crash-safe: create a new secret item, atomically persist its reference, then retire the previous item.
Record deferred cleanup so a crash cannot silently lose the current credential or leave abandoned items indefinitely.
Deleting a connection retires its secret through the same recoverable cleanup mechanism.
Scope secret ownership to stable workspace and connection identities.
Bind ownership to a machine-local workspace registration; a copied workspace UUID alone cannot establish credential ownership.
Copied workspaces require credential re-entry or explicit rebinding and cannot delete another workspace's Keychain entries.
Keep replacement and deferred deletion as a small documented state transition within connection persistence, without a general transaction framework.
Locked Keychain, denied access, and missing items produce actionable errors without revealing secrets.
Headless requests that require interactive unlock fail with recovery instructions instead of waiting indefinitely.
Never fall back to plaintext storage or place secrets in process arguments.
Credential values stay out of exports, observation events, and logs.

Select the Keychain mechanism through a bounded Mac compatibility proof behind the same secret-store contract.
Compare a maintained native binding with a bounded Apple `security` utility adapter using standard input for secret-bearing requests.
Consider a helper binary only when demonstrated native requirements justify its maintenance and distribution responsibilities.
Require bounded operations, safe input encoding, sanitized errors, and predictable interactive-access behavior whichever mechanism is selected.
Do not introduce Go, TADX execution, or runtime compilation solely to reuse an existing implementation.
Any native developer toolchain prerequisite needs an explicit decision; end-user compiler installation is not an assumed requirement.
The [Apple Keychain guidance](https://developer.apple.com/documentation/security/using-the-keychain-to-manage-user-secrets) defines the underlying credential store.

### TADX reference

TADX demonstrates a narrow credential-store interface, opaque references, target-bound versioned secret records, sanitized errors, and compensation after configuration failures.
Its inspected Go Keychain dependency invokes Apple's `security` utility and sends secret-bearing writes through standard input.
These design patterns and regression scenarios are reusable without importing its Go implementation or sharing its credential namespace.
The inspected backend does not establish bounded cancellation during native calls; the harness must validate that behavior independently.

### Process scopes

Keep admission queues, deadlines, output limits, interruption, and cleanup-failure handling in shared TypeScript.
Platform implementations own launch, process identity, stop, completion, recovery, and cleanup verification.
Keep Windows Job Object behavior intact.

Propose isolated process groups and an independent watchdog for supported, non-detaching macOS providers.
The watchdog observes engine ownership and stops owned work after engine exit.
Use graceful termination followed by bounded escalation for remaining owned processes.
Persist scope records before launch and reconcile them before admitting new work.
Validate process identity and ownership before signaling; a stale numeric PID or process-group ID is insufficient.
Include process start identity, scope identity, and reboot handling in the proof design.
Uncertain cleanup retains the scope record, blocks new admissions, and presents recovery guidance.
Never target processes by executable name or broad command matching.

Process groups and a watchdog do not provide Windows Job Object containment.
Descendants can detach, and a watchdog can fail.
The proposal covers supported local providers that preserve ownership; it does not promise containment of arbitrary or hostile subprocesses.
Keep invocation admission limits, but do not advertise an equivalent hard descendant ceiling on macOS without a proven mechanism.
Name invocation capacity separately from platform descendant limits; a scheduling reservation is not an operating-system process limit.
Do not substitute a per-user process limit that affects unrelated apps.

The revised runtime contract distinguishes managed process cleanup from hard descendant containment.
Windows retains its stronger native containment and descendant ceiling.
macOS must pass the managed-process acceptance suite without claiming equivalent containment.
See [Node.js detached process behavior](https://nodejs.org/download/release/v22.13.0/docs/api/child_process.html#optionsdetached), [Apple process sessions](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/setsid.2.html), and [Apple process signaling](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/kill.2.html).

### Provider compatibility

Validate executable permission, absolute paths, PATH discovery, symlinks, spaces, and Unicode arguments without a command shell.
Require a regular executable file and executable access.
MCP configuration supports explicit executable paths; Codex and OpenCode installations must be available through the engine's PATH.
Review inherited environment variables, including macOS temporary directories and provider configuration locations.
Include `TMPDIR` and review XDG variables selectively instead of inheriting the full host environment.
Keep explicit credential bindings and existing local provider sign-in behavior.
Codex and OpenCode account sign-in remains machine-local and separate from stored connection credentials.
Check Codex sandbox behavior, OpenCode configuration isolation, MCP child ownership, and provider session continuity on each supported Mac architecture.
Report unavailable providers and unsupported launch patterns before starting a run.

## Implementation sequence

1. Approve platform scope and the process-ownership contract.
   Capture architecture decisions and add shared contract tests before restructuring runtime code.
2. Extract boundaries while preserving Windows behavior.
   Run existing lifecycle and credential regression tests against the Windows implementations.
   Replace the coupled infrastructure and remove superseded wiring as each responsibility moves to its final owner.
3. Implement and validate Keychain storage.
   Cover replacement recovery, deletion, denied access, missing items, and workspace isolation.
4. Prove macOS process supervision with local fixtures before integrating provider calls.
   Stop this phase if ownership, crash recovery, or cleanup cannot meet the approved contract.
5. Validate installed provider and MCP compatibility with bounded calls.
   Use Luna or approved free models; never use Astra for validation.
6. Add Windows and macOS CI coverage and complete real-Mac acceptance.
   Finish with an adversarial architecture review and update runtime guarantees to match demonstrated behavior.

## Architecture completion gate

- Remove credential protection methods from the process supervisor.
- Remove Windows helper compilation and native details from shared process coordination.
- Remove concrete process-supervisor dependencies from credential persistence.
- Move executable resolution into its own focused module.
- Keep platform imports confined to composition and platform infrastructure.
- Reject provider imports of platform implementations and connection-service imports of process drivers through automated architecture checks.
- Reject shared coordinator imports of Windows or macOS implementation modules.
- Retire replaced code and temporary migration wiring without deleting historical run evidence.
- Keep format migration explicit, tested, and separate from normal runtime behavior.

The final review traces a credential save, target invocation, cancellation, and crash recovery through the same shared workflow on both platforms.
Parallel product workflows, permanent legacy branches, and forwarding layers without a distinct responsibility fail that review.

## Acceptance evidence

- Exercise cancellation, timeout, output limits, direct-child exit, engine crash, watchdog failure, and restart recovery.
- Exercise descendants that ignore graceful signals, retain output pipes, or attempt detachment.
- Reject unsafe stale identities and verify concurrent workspaces cannot stop each other's processes.
- Cover reboot reconciliation and shutdown while work waits for admission.
- Verify Keychain operations without secret exposure in arguments, files, logs, or exports.
- Run discovery, a bounded target evaluation, MCP answer submission, research interruption and resume, and optional judging on a real Mac.
- Verify browser observation and controls, CLI parity, SQLite ownership, artifact writes, and evaluator execution.
- Run formatting, architecture checks, types, lint, tests, and production builds on supported platforms.
- Keep unsupported behavior visible and prevent new admissions after unresolved cleanup.

Windows-only checks cannot establish Mac compatibility.
Access to a real Mac is a prerequisite for release acceptance, including interactive Keychain behavior and actual provider authentication.
CI fixtures supplement that evidence; they do not replace it.

## Implemented decisions

- One shared coordinator uses Windows Job Objects or managed macOS process groups through private process-driver contracts.
- Independent credential stores use Windows DPAPI or Apple's built-in `security` utility with bounded stdin requests.
- Versioned connection storage uses opaque references and recoverable replacement and deletion journals.
- Legacy Windows ciphertext migration is isolated from normal connection operations.
- Architecture gates enforce the new internal boundaries and composition ownership.
- CI targets macOS 15 on Apple Silicon and Intel, alongside Windows and the platform-independent Linux test suite.

## Validation and remaining release gate

Windows validation covers the complete quality pipeline, native DPAPI, legacy connection migration, and browser-shell and CLI startup against copied connection settings.
Linux container fixtures exercise the POSIX implementation with Node.js 22.13.0, including cancellation, output limits, timeouts, engine IPC loss, frozen-watchdog recovery, and unrelated-process rejection.
These fixtures do not establish native Mac compatibility.
Adversarial review confirms one shared runtime workflow and separate ownership of process mechanics and secret storage.
Review findings in asynchronous shutdown, watchdog initialization, and recovery now have fixes and regression coverage.

Native Mac acceptance still requires actual Keychain behavior, Codex and OpenCode authentication, Tableau MCP, browser observation, research, and optional judging.
Run the configured CI jobs and the acceptance scenarios above on real Macs before claiming release support.
Record the tested macOS versions and architecture-specific provider behavior before selecting a minimum supported macOS version.
No interactive Mac host is available in the current development environment.
GitHub Actions runs native process fixtures on Apple Silicon and Intel Macs with Node.js 22.13.0 and 24.
Those results establish fixture coverage only, not authenticated provider or interactive Keychain acceptance.
See [the runtime reliability review](runtime-review-2026-10-09.md) for the cleanup, diagnostic, and MCP configuration regression scope.
