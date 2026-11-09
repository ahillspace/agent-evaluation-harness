# Evaluate an HTTP agent

Use an external target when the agent already runs in another system.
The harness sends questions and grades final answers.
The external system owns prompts, models, tools, routing, deployment, and internal observability.

## Configure an endpoint

1. Open **Settings > External agents**, or choose **Use an external agent** in Run Setup.
2. Add a name and an HTTPS endpoint.
   HTTP is accepted only for loopback development endpoints.
3. Choose no authentication, a bearer token, or an API key header.
   Credentials use the operating system secret store.
4. Set the question field and answer JSON Pointer.
   The defaults send `question` and select `/answer`.
5. Use **Preview request** to inspect the public JSON without making a network call.
6. Use **Send sample request** to invoke the endpoint and inspect its answer.
   Sample requests can cause remote work and are not graded.
7. Save the agent, select a question bank, and start a Run.

The default request body contains question text, public context, and public answer-format guidance.
Expected answers, private evaluator settings, and judge criteria never enter this request.

```json
{
  "question": "What is the total revenue?",
  "context": null,
  "answerFormat": null
}
```

The default response shape is:

```json
{ "answer": 42 }
```

Answers retain their JSON type, including strings, numbers, booleans, null, arrays, and objects.
An empty answer pointer selects the entire response.
Advanced settings support a JSON body template, existing-slot JSON Pointer bindings, non-secret headers, and a deployment label.
Bindings can use question text, public context, answer format, Run ID, question ID, repetition, and attempt ID.
No executable mapping scripts are supported.

## Understand controls and failures

Pause finishes active requests and stops new admissions.
Halt and Cancel stop local waiting; they cannot confirm that the remote agent stopped.
An interrupted dispatched request has unknown remote completion.
Resume requires acknowledgment before sending another attempt that could duplicate remote work.
The harness never automatically retries a failed request.

The default request deadline is 120 seconds, configurable from 1 second to 10 minutes.
Request bodies use the smaller of 1 MiB and the invocation's `maxOutputBytes` limit.
Decoded response bodies use the smaller of 4 MiB and `maxOutputBytes`.
Redirects, cookies, invalid certificates, malformed UTF-8 or JSON, missing answer selections, and asynchronous 202 responses are unsupported.
HTTP 204 and non-success statuses are execution failures.
A received answer with the wrong public structure is completed evidence with an incorrect assessment, after configured representation policies apply.

## Review and reuse results

Observe shows request events, duration, final answers, and independent assessments.
Unobserved internal activity, model identity, usage, and cost are not invented.
Deterministic grading remains the default.
Custom evaluators and optional judges must declare that their checks can use answer-only evidence.
Incompatible checks are rejected before launch; saved-evidence judging records unsupported evidence without a provider call.

Runs supports comparison, rescoring, human review, configuration reuse, and blueprints.
External JSON exports contain endpoint invocation settings and credential placeholders.
They cannot export the remote agent's system prompt or implementation.
Remote deployment changes remain outside the harness's control; a deployment label helps identify the version you intend to evaluate.

## Credential lifetime

Saving changed authentication creates a new credential version.
Frozen Runs and sample snapshots retain their original version for execution, Resume, and resource recovery.
Removing a saved endpoint removes its catalog entry; credentials retained by historical snapshots remain workspace-owned.
There is no automatic purge of retained credential versions.
Exported JSON contains placeholders and cannot transfer authentication to another workspace.

## Headless operations

The CLI and web API call the same operations:

- `targets.list`, `targets.save`, and `targets.delete` manage endpoint configurations.
- `targets.preview` builds a request without dispatch.
- `targets.sample` sends an explicit sample request.
- `runs.launch` accepts `target.kind: "external"` with `adapterId: "http"` and `adapterVersion: 1`.
- Existing Run inspection, controls, comparisons, and rescoring apply to both target kinds.
- `runs.export-target` exports the relevant configuration scope.

Run CLI discovery to obtain the exact JSON schemas.
The legacy `runs.export-agent` operation remains available for managed targets.

## Implementation and verification

[HTTP configuration](../src/contracts/http-target.ts) owns endpoint, header, and JSON Pointer validation.
[buildHttpRequest](../src/runtime/targets/http-mapping.ts) preserves public input types.
[executeHttpTarget](../src/runtime/targets/http.ts) owns transport bounds and failure classification.
[External target architecture](external-targets.md) describes dispatch checkpoints, credential retention, and recovery ownership.
[HTTP acceptance tests](../tests/acceptance/http-target.test.ts) exercise the shared application, server, and CLI workflow through loopback fixtures.
The dated [verification record](http-target-verification.md) does not establish current live endpoint or native Mac compatibility.
