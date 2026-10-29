# Add an internal target adapter

Adapters are shipped and maintained by product developers.
They are not dynamically loaded end-user plugins.
Generic HTTP is implemented; Agentforce and Copilot Studio are not included.

## Ownership

| Layer            | Responsibility                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Contracts        | Versioned target configuration, public question projection, capabilities, and normalized evidence                      |
| Application      | Run and sample lifecycle, immutable artifacts, checkpoint persistence, controls, and evaluation compatibility          |
| Runtime registry | Adapter lookup, admission, cancellation, deadlines, safe capacity, and bounded recovery                                |
| Concrete adapter | Provider configuration, credential binding, request or session lifecycle, evidence normalization, and resource cleanup |
| Web              | Provider configuration forms and presentation of shared engine results                                                 |

Keep provider branches out of RunService and evaluation.
Keep HTTP request handling inside the HTTP adapter.
AgentConfig continues to describe managed targets, researchers, and local judges.

## Implement the adapter contract

Implement `TargetAdapter` in [adapter contracts](../src/runtime/targets/contracts.ts).
The contract is private runtime infrastructure, while `RuntimePort` remains the application-facing boundary.
Use a stable ID, an explicit configuration version, and truthful capabilities.
Validate configuration without resolving secrets.
Provide a credential binding that separates opaque secret references from public configuration.
Provide public request preview when meaningful; it must not invoke the target.
Resolve and validate required authentication before Run creation.

Invoke receives a frozen target, public question, IDs, repetition, deadline, cancellation signal, event callback, and durable checkpoint callback.
It never receives expected answers or private evaluator criteria.
Await checkpoint persistence before a remote operation whose outcome could require recovery.
For session creation, record enough intent to reconcile an uncertain creation without repeating the original question.
Use provider idempotency only when that provider guarantees its semantics.

Return TargetAdapterOutput with explicit evidenceScope and cleanup status.
Return a received answer even if cleanup is unavailable.
Ordinary rejected invocations guarantee completed local cleanup; unresolved resources must reject with code cleanup_failed.
Never claim remote cancellation from a locally closed HTTP connection.
Never fabricate model identity, internal traces, or token usage.
The registry rejects evidence scope that contradicts registered capabilities and blocks admission after unresolved cleanup.

Recovery receives frozen target configuration, the private checkpoint, a cancellation signal, and a bounded deadline.
Its job is reconciliation and cleanup, never resending the original question.
The default recovery deadline is 30 seconds.
Recovery failures preserve the journal and block startup admission.
Cleanup must be idempotent and respect the supplied signal.
Close must settle owned resources and pending work.

## Register an integration

1. Add a focused configuration schema under `src/contracts` and a concrete adapter under `src/runtime/targets`.
2. Register the adapter in LocalRuntime composition in `src/runtime/index.ts`.
   Catalog validation, credential binding, preview, invocation, and recovery dispatch through the registry.
3. Add the provider configuration form under `src/web` and expose the shipped integration in external-agent selection.
   UI changes must use existing application operations rather than provider APIs.
4. Add local provider fixtures covering cancellation, timeout, uncertain completion, checkpoint recovery, cleanup failure, secret exclusion, and saved configuration reuse.
5. Run the full validation suite and review dependency boundaries.

The existing [session fixture](../src/runtime/targets/registry.test.ts) demonstrates invocation and recovery without introducing another Run workflow.
A session-based integration must implement create, invoke, reconcile, and close within its adapter using this contract.
Provider-specific authentication variants can extend the typed credential contract without changing evaluation or orchestration ownership.

## Persistence and compatibility

New Run manifests freeze target configuration and capabilities.
Existing manifests use savedTarget to interpret legacy agent fields without rewriting data.
Storage migration 3 adds target immutability to blueprints and preserves earlier record bytes.
The current database version and later migrations belong to [architecture](architecture.md#storage-and-schema-ownership).
Private invocation journals are separate from immutable answer artifacts and are excluded from public observation queries.
Retained credential versions support immutable snapshots; do not delete a version still owned by a Run, sample, or recovery record.
The current external catalog retains these versions for the workspace lifetime, without automatic garbage collection.
Managed bindings also retain identity-bound credential versions through ConnectionService.
Ordinary discovery captures a transient settings/credential pair without creating a retained historical snapshot.

## Existing composition and checks

[LocalRuntime](../src/runtime/index.ts) registers only `ManagedTargetAdapter` and `HttpTargetAdapter`.
[TargetRegistry](../src/runtime/targets/registry.ts) checks adapter version, capabilities, cleanup status, recovery deadlines, and admission safety.
[TargetInvocations](../src/application/target-invocations.ts) journals private checkpoints before forwarding them to application persistence.
[ExternalTargetCatalog](../src/runtime/targets/catalog.ts) owns credential identity and retained references.
Follow [external target architecture](external-targets.md) for current operation traces and [runtime contracts](runtime.md) for process and provider boundaries.

The registry fixture covers the extension seam without establishing compatibility with an unimplemented external provider.
Native or live-provider checks need separate recorded evidence.
