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
The CLI accepts loopback HTTP endpoints only.
The HTTP equivalent is `POST /api/commands/<operation>` with the same JSON body; discovery uses `GET /api/discovery`.

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

Use event cursors for incremental reads rather than repeatedly requesting the entire history.
`runs.observe` returns live observation without the full frozen manifest.
`runs.attempt` retrieves full evidence for a selected attempt; its input requires `runId` and `attemptId`.

Reusing a launch idempotency key with identical input returns the original run.
Reusing it with different input is an error.
Use a new key for an intentional new evaluation.

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

This creates a linked run rather than changing original answers.
An optional `resultIds` array restricts the selection.
If the engine requires acknowledgment of possible repeated actions, inspect the prior attempts before setting `acknowledgeDuplicateWork` to `true`.

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
