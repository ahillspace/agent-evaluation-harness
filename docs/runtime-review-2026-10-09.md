# Runtime reliability review

This review addresses the findings against commit `e12c3759c752277ed122562bef67644357152377`.
The changes preserve the existing engine, runtime, and evaluation boundaries.
No target-agent or paid judge runs are required for these checks.

## Required guarantees

- Returned cleanup errors contain safe diagnostics without retaining original exception objects or captured process output.
- Conflicting process identity evidence blocks cleanup and further admission.
- Process inspection retries bounded transient observations without treating permission denial as proof of successful cleanup.
- Provider failures remain inspectable when cleanup also fails, with cleanup remaining the admission-blocking condition.
- Connection probes and managed MCP execution share the same inherited environment policy.
- Tableau feature overrides preserve package defaults through direct and symlinked entry points.
- Invocation owners retain responsibility for generated feature-provider files through cancellation and recovery.
- Jev's optional answer-only fallback permits one additional HTTP attempt.
- Late profile publication cannot replace a newer bank or profile selection.

## Validation boundaries

Portable regression tests exercise the runtime and HTTP boundaries with local fixture processes and provider responses.
Mounted React tests exercise delayed publication across selection changes.
These checks do not establish authenticated provider behavior on a user's Mac.

The prior commit's GitHub Actions run `37897267729` passed Windows and Linux jobs but failed all four macOS jobs.
The macOS failures include permission-denied process probes with an empty membership snapshot during normal exit and cancellation.
The revised branch must pass the configured native macOS fixture jobs before those failures count as resolved.

Interactive Keychain behavior, company certificate configuration, authenticated Tableau MCP, and provider subscriptions still require user-machine acceptance.
Never infer permission to stop an unrelated process from a numeric PID, a same-user group, or well-formed persisted fields.
Uncertain recovery retains its ownership records and blocks admission.
Recovery with an already reaped leader cannot rely on an old lease alone to accept a zombie group.
Only current verified ownership or continuity established within the same cleanup can settle that case.

## Executed checks

The Windows quality pipeline passes formatting, architecture boundaries for 146 production modules, type checking, lint, tests, and the production build.
The test suite reports 488 passed and 14 skipped across 91 files.
Skipped coverage includes native POSIX process fixtures and the symlink launch check.

Regression coverage includes detailed error inspection, nested causes, watchdog exit 125, Bedrock provider rejection plus MCP cleanup failure, and retained usage.
Local HTTP tests cover Jev fallback rejection with exactly two requests total: the original trace request and one answer-only attempt.
Mounted React tests cover bank changes, editor closure and reopening, and current model settings during delayed publication.
MCP grandchild fixtures preserve a corporate CA path containing spaces while excluding unrelated credentials and TLS-disable inheritance.
Cancellation fixtures retain parent-owned modules until confirmed settlement and exercise abandoned-resource recovery.

A local check of the pinned Tableau MCP 4.13.3 package returned 27 tools against a loopback Tableau fixture.
Default authoring and workbook tools remained available alongside three explicitly enabled knowledge tools.
That check used no Tableau credentials or paid model calls and does not establish the actual macOS npx launch path.

Native GitHub Actions results for the pushed revision must be checked separately.
