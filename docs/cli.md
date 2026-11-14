# Use the CLI

The CLI and web interface operate on the same local engine and saved workspace.
Start the server with `npm start` after building the project.
Run CLI commands from another terminal in the repository.

## Discover commands and inputs

```sh
node dist/cli.js --help
node dist/cli.js discover
node dist/cli.js workspace.get
```

Before building, use `npm run cli --` in place of `node dist/cli.js`.
The compiled entry point emits JSON without npm's script banner, which is useful for automation.
There is no separately installed `aeh` executable in this source checkout.

`--help` describes CLI syntax.
`discover` contacts the engine and returns operation names with validated JSON input schemas.
Use that catalog for authoritative fields, defaults, and supported settings.
Discovery does not launch an evaluation.

Choose one input source: `--file path.json`, `--json JSON`, or `--stdin`.
The examples below use files to avoid shell-dependent JSON quoting.
Commands return JSON; failures return an `error` object and exit with code 1.

Use another local server with:

```sh
node dist/cli.js workspace.get --url http://127.0.0.1:4390
```

Alternatively, set `AEH_URL` in the CLI's environment.
An explicit `--url` overrides `AEH_URL`; without either, the CLI uses `http://127.0.0.1:4381`.
The CLI accepts loopback HTTP endpoints only.
The HTTP equivalent is `POST /api/commands/<operation>` with the same JSON body; discovery uses `GET /api/discovery`.

## Transport and failure contracts

The CLI does not open a workspace database or start an engine.
[`runCli`](../src/cli.ts) sends requests to [`startServer`](../src/server.ts), which dispatches commands through [`Application.execute`](../src/application/application.ts).
React uses the same route through [`command`](../src/web/api.ts).
[`commandSchemas`](../src/contracts.ts) owns input validation and discovery; `CommandResultMap` owns the TypeScript result contract.
The discovery response describes inputs, not result schemas or command side effects.

HTTP errors contain `error.code` and `error.message`; schema errors also contain `error.details`.
The CLI preserves an engine error response and exits with code 1.
Argument, input-file, JSON parsing, and connection failures use the local `cli_error` code.
Successful commands exit with code 0 and print their JSON result to standard output.
HTTP responses use 403 for `forbidden`, 404 for `not_found`, and 500 for `internal_error`.
They use 409 for `idempotency_conflict` and `invalid_state`, and 400 for other error codes, including `conflict`.
Branch on `error.code` when your automation needs to distinguish stale publication from invalid input.

A lost response does not establish that the operation failed.
Preserve the exact launch payload and `idempotencyKey` before sending `runs.launch` or `research.launch`.
Replay that payload to recover an accepted launch; changed input with the same key is rejected.
Do not assume every mutation supports replay: inspect its discovery schema and operation contract.
Closing a client request does not send a Run control action.
Use `runs.control` or `research.control` to pause, halt, resume, or cancel engine work.

The [configuration guide](configuration-guide.md#local-engine-configuration) owns server configuration and the local trust boundary.
The [architecture guide](architecture.md) owns application services, immutable records, and recovery guarantees.

## Save a Tableau connection

Use `connections.save` to create or update a saved Tableau connection.
The settings object holds the Tableau server, site, token name, local MCP command and arguments, additional environment variables, and feature flags.
The PAT value belongs under `credentials.patValue`, separate from the settings object.

```json
{
  "name": "Tableau QA",
  "provider": "tableau",
  "settings": {
    "server": "https://tableau.example.com",
    "site": "my-site",
    "patName": "harness-token",
    "mcpCommand": "npx",
    "mcpArgs": ["-y", "@tableau/mcp-server@4.13.3"],
    "mcpEnv": {
      "INCLUDE_DATASOURCE_IDS": "your-datasource-id"
    },
    "mcpFeatures": {
      "knowledge-tools": true
    }
  },
  "credentials": {
    "patValue": "SUPPLY_VIA_PROTECTED_INPUT"
  }
}
```

Send this object to `node dist/cli.js connections.save --stdin` or `POST /api/commands/connections.save`.
For updates, include the connection `id`; omit `credentials` to keep the currently saved PAT.
The default `mcpCommand` is `npx`, and the default `mcpArgs` are `["-y", "@tableau/mcp-server@4.13.3"]`.
The web editor's **Tableau MCP settings (JSON)** accepts `mcpCommand`, `mcpArgs`, `mcpEnv`, and `mcpFeatures`.
`mcpEnv` maps additional environment variable names to string values, and `mcpFeatures` maps feature names to booleans.
The harness reserves its authentication, transport, tool selection, and internal feature override variable.
Do not put a real PAT in `settings`, `mcpArgs`, command-line arguments, or a committed JSON file.
Use the web editor or provide the credential through controlled standard input.

## Create a bank and launch a run

Save this small example as `bank.json`:

```json
{
  "name": "Arithmetic example",
  "questions": [
    {
      "id": "sum",
      "text": "What is 7 plus 5? Return a number.",
      "expected": 12,
      "tags": ["example"]
    }
  ]
}
```

Create the bank and inspect runtime availability:

```sh
node dist/cli.js banks.create --file bank.json
node dist/cli.js runtime.discover
```

Copy the returned `bank.latestRevisionId` and a model ID from discovery into `launch.json`:

```json
{
  "name": "Arithmetic baseline",
  "bankRevisionId": "REPLACE_BANK_REVISION_ID",
  "target": {
    "kind": "managed",
    "agent": {
      "harness": "codex",
      "model": "REPLACE_MODEL_ID",
      "systemPrompt": "Answer the question accurately using the required submission format.",
      "tools": [],
      "connections": []
    }
  },
  "repetitions": 1,
  "idempotencyKey": "arithmetic-baseline-1"
}
```

This example uses local Codex authentication and no external tools.
Launching invokes your provider and consumes its quota or paid usage.
For analytics questions, configure the required connections and tool allowlist through the discovered schemas or web setup.

```sh
node dist/cli.js runs.launch --file launch.json
```

Copy the returned `run.id` into `run-reference.json`:

```json
{ "runId": "REPLACE_RUN_ID" }
```

Inspect the run or its event history:

```sh
node dist/cli.js runs.get --file run-reference.json
node dist/cli.js runs.events --file run-reference.json
```

`runs.get` returns the current Run snapshot with its full frozen manifest.
`runs.observe` returns the same current state without that manifest.
Both operations accept only `runId` and return no event history or cursor.
Use `runs.events` or `runs.attempt-events` with an optional `cursor` for incremental history reads.
`runs.attempt` retrieves full evidence for a selected attempt; its input requires `runId` and `attemptId`.
Its response retains the complete recorded output, failure, and assessments; event history is read separately through `runs.attempt-events`.
For an adopted attempt, `runs.attempt-events` includes the physical owner's events and the requesting Run's contextual events for that attempt in one ordered page, excluding other Runs.

Reusing a launch idempotency key with identical input returns the original run.
Reusing it with different input is an error.
Use a new key for an intentional new evaluation.

## Author and check a bank

Use `banks.publish` to save questions and deterministic grading rules atomically.
For a new bank, supply `name`, `questions`, `evaluatorName`, and `evaluatorSettings`.
For an existing bank, also supply `bankId`, `baseRevisionId`, and `baseEvaluatorRevisionId` from the bank detail you edited.
The engine rejects stale bases and failing calibration examples without publishing a partial revision.
Existing runs keep their frozen questions and evaluator.

These operations check a draft without publishing or calling a model:

| Operation               | Input                                       | Result                                                                     |
| ----------------------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| `banks.check-answer`    | `question`, `settings`, `answer`            | The deterministic verdict for one sample answer.                           |
| `banks.calibrate-draft` | `questions`, `settings`                     | Calibration results for the proposed bank and rules.                       |
| `banks.preview-draft`   | `bankId`, `questions`, `settings`, `runIds` | Proposed verdicts beside the current automatic verdicts for saved answers. |

Preview requires compatible saved questions and uses their sealed answers; it does not rerun the target agent.
Use `banks.export-package` with `bankRevisionId` and optional `evaluatorRevisionId` and `jevProfileRevisionId` to export a versioned package containing questions, deterministic rules, and the selected Jev profile.
The package excludes credentials.
The web importer accepts this package and reviews included settings before publication.
Use `discover` for complete schemas and defaults.

## Find saved runs

Save the filters and page size as `run-search.json`:

```json
{
  "bankId": "BANK_ID",
  "status": "completed",
  "search": "supply chain",
  "limit": 25,
  "offset": 0
}
```

```sh
node dist/cli.js runs.list --file run-search.json
```

Bank, status, and search filters are optional.
Search matches Run names, frozen bank names, and agent labels across all saved Runs before pagination.
The response includes the matching `total` and `nextOffset`; use that offset with the same filters to request another page.
A null `nextOffset` marks the last page.
Rows contain compact target labels, answer counts, and saved score summaries.
Use `runs.get` for the selected Run's frozen configuration and evidence.

## Control and recover a run

Save a control request as `control.json`:

```json
{ "runId": "REPLACE_RUN_ID", "action": "pause" }
```

```sh
node dist/cli.js runs.control --file control.json
```

Supported actions are `pause`, `halt`, `resume`, and `cancel`.
See [control and recovery behavior](configuration-guide.md#control-and-recover-work).

To rerun failed questions after active work settles, save `retry.json`:

```json
{
  "runId": "REPLACE_RUN_ID",
  "idempotencyKey": "failed-questions-retry-1"
}
```

```sh
node dist/cli.js runs.retry-failed --file retry.json
```

This recovers failed unanswered slots in the original Run and returns that same Run identifier.
An optional `resultIds` array restricts the selection without resuming unrelated unfinished questions.
Completed answers, including incorrect answers, are excluded.
An optional `expectedExecutionId` matches `run.execution.id`, or the Run identifier for a historical record without a context.
A stale new action fails before admission.
If acknowledgment is required, inspect the prior attempts before setting `acknowledgeDuplicateWork` to `true`.

Keep the exact request and idempotency key until its acknowledgment arrives.
Replaying the accepted request returns its receipt without restarting work, including after Halt or restart.
Use a new key only for an intentional new recovery.
Prior attempts and saved scores remain available.
The new automatic score includes every logical slot and keeps the earlier automatic family unchanged.
`runs.get` exposes the current execution, engine-owned recovery eligibility, selected score, and historical answer sources.

Resume can also carry a durable key and execution guard:

```json
{
  "runId": "REPLACE_RUN_ID",
  "action": "resume",
  "idempotencyKey": "resume-unfinished-1",
  "expectedExecutionId": "REPLACE_EXECUTION_ID",
  "acknowledgeDuplicateWork": true
}
```

Run control preserves its key, acknowledgment, and execution guard when routed to an owning research session.
The guard refers to the requested Run; a historical Research Run can control the session's current child.
Replaying an accepted control key returns the current view without scheduling or interrupting work, even after control ownership changes.
Resume continues an unsettled execution's scope.
A Run whose final slot settles nonfatally under Pause or Halt completes without another target request.
Fatal stops and remaining unfinished slots stay stopped; Cancel takes priority over late cleanup failures.
A paused research session can then resume its researcher against that completed Run.
After that scope settles, it admits only remaining pending or interrupted slots in a new continuation.
Cancelled Runs cannot resume.
Manual recovery or continuation after a terminal research session uses ordinary frozen Run limits.
The same operations apply without an additional budget option.
They preserve research provenance and prior spending while attributing new target and automatic judge work only to the Run.
The parent must be terminal and target/judge work must have settled; paused or halted research retains ownership.
Historical linked reruns remain readable; the retired Apply operation is unavailable.

## Score saved answers

Save `score.json` with the evaluator revision you want to apply:

```json
{
  "runId": "REPLACE_RUN_ID",
  "name": "Reviewed comparison rules",
  "source": "deterministic",
  "evaluatorRevisionId": "REPLACE_EVALUATOR_REVISION_ID"
}
```

```sh
node dist/cli.js runs.assess --file score.json
```

Add `bankRevisionId` when applying a corrected compatible reference revision.
The operation creates a named assessment pass without another target invocation.
Deterministic assessment uses no model calls.
For model assessment, use `source: "llm"` with `judge`, or `source: "jev"` with `jevJudge`, following discovery schemas.
Model assessment can consume provider usage.

Save a pass reference with `runId` and the returned assessment `id` as `passId`:

```json
{ "runId": "REPLACE_RUN_ID", "passId": "REPLACE_PASS_ID" }
```

Use the reference to inspect, select, or export that score:

```sh
node dist/cli.js runs.assessment --file pass-reference.json
node dist/cli.js runs.select-assessment --file pass-reference.json
node dist/cli.js runs.export-assessment --file pass-reference.json
```

`runs.retry-assessment` uses the same reference and creates a derived pass for failed judgments.
It does not rerun the target.

## Record a human review

Save `review.json` with the selected parent score and the decisions you want to change:

```json
{
  "runId": "REPLACE_RUN_ID",
  "parentPassId": "REPLACE_PASS_ID",
  "name": "Analyst review",
  "reviewer": "Reviewer name",
  "overrides": [
    {
      "resultId": "REPLACE_RESULT_ID",
      "verdict": true,
      "note": "Verified against the source and published question requirements."
    }
  ]
}
```

```sh
node dist/cli.js runs.review-assessment --file review.json
```

The result is a new human assessment pass; unchanged judgments and the original score remain available.
Use `banks.report-finding` and `banks.resolve-finding` for reference issues that require a bank correction or exclusion policy.

## Automate research and reuse

`research.launch` takes a baseline launch configuration, researcher configuration, objective, permitted changes, and budgets.
Its discovery schema describes `selectionMetric`, `allowResearcherStop`, `stopGuidance`, and the available limits.
The baseline and candidates invoke target providers; researcher turns also consume provider usage.

Use `research.get` to inspect session state, `research.turn` for a specific saved turn, and `research.control` for session controls.
See [bounded research behavior](configuration-guide.md#run-bounded-research) before automating it.

Use `runs.compare` with a `runIds` array to compare two or more saved runs.
Use `blueprints.save` with `name` and `runId` to save reusable launch settings.

Export the frozen target configuration as JSON:

```sh
node dist/cli.js runs.export-target --file run-reference.json
```

`runs.export-agent` is also available for managed agents.
Exports contain credential placeholders and omit private expected answers.
Configure the required credentials before reusing an export outside this workspace.

## Keep automation bounded

Use `discover` instead of copying a complete schema reference into scripts or prompts.
Preserve returned IDs, idempotency keys, event cursors, and errors.
Keep secrets out of command arguments and committed input files.
Use the web connection editor or controlled standard input for credential-bearing requests.
The same engine validation, lifecycle controls, and immutable evidence rules apply to CLI and web operations.
