# HTTP target verification

Verification date: October 4, 2026.
The build adds generic HTTP evaluation and a developer-maintained runtime adapter boundary.
No live model calls, Astra tests, Agentforce integration, commits, or pushes were used.

## Automated checks

Windows minimum-runtime validation uses Node.js 22.13.0.
Its complete suite passes 309 tests, with 11 platform-specific skips across 53 test files.
The final Linux Node.js 22.13.0 container suite passes 303 tests, with 17 platform-specific skips.
The final Windows Node.js 25.6.1 validation also passes 309 tests, with 11 platform-specific skips, and all build gates.

Formatting, architecture boundaries, TypeScript, ESLint, and production build checks pass.
Architecture validation covers 109 production modules.
Thirteen HTTP acceptance tests exercise real loopback HTTP requests through the application, server, and CLI contracts.
They cover frozen targets, configuration exports, answer-only grading, private-reference exclusion, Pause, Halt, Cancel, Resume acknowledgment, crash recovery, timeouts, no retries, invalid public answer structure, and shutdown during a sample.
Transport fixtures cover JSON types, JSON Pointers, UTF-8 errors, status handling, request and response limits, authentication redaction, and mapping failures.
Registry fixtures cover internal session adapters, cleanup safety, bounded recovery, evidence compatibility, and owned deadline timer cleanup.
Catalog tests cover credential binding, rotation, retained snapshot ownership, deletion, restart, and copied-workspace restrictions.
Storage tests preserve legacy record bytes and protect new target manifests and blueprints.

A Windows minimum-runtime run under competing heavy validation timed out in two timing-sensitive tests.
Recovery now owns and clears its deadline timer instead of depending on a temporary timeout signal.
The process-capacity test passed in isolation without changing its assertions or timeout.
The final minimum-runtime suite passed without competing validation jobs.

## Browser checks

Chrome exercised the built app against a separate local fixture workspace.
The workflow created a bank, configured an external endpoint, changed its question field, previewed the request, and sent a sample.
The sample answer remained visible after saving configuration.
The browser then launched a Run, observed request and answer events, inspected deterministic grading, exported endpoint configuration, reused a saved Run, and saved a blueprint.
Settings separates external agents, connections, and local harness discovery.
External setup hides managed model, prompt, tools, and research controls.
The sample display presents the answer first and keeps transport details in a disclosure.
A browser password-manager overlay intercepted a pointer action; keyboard activation verified the export dialog.
No browser console errors were observed during the checked workflow.

## Review and limits

Independent review required fixes for credential ownership, recovery journal settlement, and sample shutdown cancellation.
A closure review found no remaining material blockers in those fixes.
The shared registry and application lifecycle support future session adapters without a second Run engine.

Native macOS execution and macOS Keychain integration were not available for this task.
Linux tests exercise POSIX paths but do not establish native macOS acceptance.
Live third-party endpoints and hosted Agentforce or Copilot Studio agents were not tested.
Retained credential versions deliberately have no automatic garbage collection until the app defines an explicit artifact and credential purge lifecycle.
