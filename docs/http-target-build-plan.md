# HTTP target build execution plan

Status: implemented and reviewed.
See http-target-verification.md for executed checks and remaining platform limitations.
The product specification is external-targets.md.

## Architecture and guarantees

Introduce one discriminated target contract, keeping managed AgentConfig for researchers and local judges.
Application services retain one Run lifecycle and immutable evidence workflow.
Runtime composition registers developer-maintained adapters behind a common invocation and recovery contract.
HTTP records answer-only evidence and never claims remote cancellation or internal observability.
Separate external target admission from native process supervision and make unused native runtime readiness lazy.
Preserve existing records and artifact bytes through a bounded compatibility reader; new writes use the canonical target shape.

## Work sequence

1. Add shared JSON and target contracts, compatibility helpers, and contract tests.
2. Build bounded HTTP mapping and transport with local fixture tests in an isolated adapter.
3. Add target registry, shared admission, checkpoint/recovery contracts, and managed delegation.
4. Add external configuration storage, secret management, application catalog operations, preview, and explicit sample requests.
5. Integrate target launch, controls, uncertain remote completion, frozen exports, blueprints, and research restrictions.
6. Add answer-only evidence requirements to evaluator and judge configuration and enforce them during launch and saved-evidence assessment.
7. Update target-first setup, external settings, request observation, results, and reusable drafts.
8. Add end-to-end HTTP/CLI and browser fixtures, including control recovery and credential boundaries.
9. Run formatting, architecture checks, types, lint, tests, production build, and independent review.
10. Update maintainer adapter instructions and record actual verification, including platform limitations.

## File ownership

Root owns contracts, application, persistence, runtime composition, UI, documentation, and integration.
The delegated HTTP implementation owns contracts/http-target.ts and runtime/targets/http modules and tests.
Shared schema names are coordinated before dependent changes.
No Agentforce or Copilot Studio implementation, runtime plugin loader, or live model test is included.

## Acceptance gates

- Existing managed target, researcher, judge, export, and evidence behavior remains supported.
- External target configuration contains no invented local-agent fields.
- Public request projection excludes gold answers and private evaluator criteria.
- HTTP cannot bypass target admission or leak credentials into artifacts.
- Transport failure and invalid selected answers have distinct accounting.
- Halt, Cancel, restart, and Resume preserve uncertain remote completion and never silently retry.
- Internal adapter fixture exercises session cleanup and recovery without changing Run orchestration.
- Catalog edits cannot alter saved target snapshots.
- No local executable or native helper is required for external-only work.
- Unsupported trace-dependent evaluations cannot produce false incorrect verdicts.
- UI hides irrelevant controls and presents unavailable telemetry honestly.
- Final review checks for obsolete wiring, provider-specific lifecycle branches, and unexecuted validation claims.
