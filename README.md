# Agent Evaluation Harness

Evaluate local analytics agents through one headless engine and a React workspace.
Run one frozen configuration against a question bank, inspect evidence, revise grading, and compare saved results.
Optional research proposes configurations through one persistent provider conversation and launches ordinary Runs.

## Start the app

Use Node.js 22.13.0 or newer.
The runtime has Windows and macOS implementations behind the same engine contracts.
Native Mac acceptance, including Keychain access and authenticated provider execution, remains pending.
Linux runs core tests but does not enable live provider execution.
Install Codex or OpenCode separately and sign in on each machine, or configure a supported API-key connection.
Keep Node.js, npm, and the selected provider executable available on `PATH` when starting the engine.
macOS uses the built-in Keychain and process utilities without a Go runtime or native compiler requirement.

```sh
npm install
npm run build
npm start
```

Open `http://127.0.0.1:4381`.
The engine stores its local workspace in `.aeh`.
Set `AEH_DATA_DIRECTORY` to select another workspace and `PORT` to select another port.
Only one engine can own a workspace.
Connection credentials use Windows DPAPI or macOS Keychain through a separate secret store.
Copying or moving a workspace preserves evidence but requires entering connection credentials again.
Provider account sign-in also remains local to each machine.

For development, run `npm run dev` and `npm run dev:web` in separate terminals.
The Vite interface uses port 5181 and forwards API requests to port 4381.

## Run an evaluation

1. Open **Settings** and discover installed Codex or OpenCode harnesses.
2. Add a Tableau connection or a model provider connection when needed.
3. Open **Question banks** and author or import questions with expected answers.
4. Open **Run**, choose the bank, agent configuration, tools, and repetitions, then start.
5. Inspect **Observe** for saved activity, answers, deterministic grading, and optional judge assessments.
6. Open **Results** to compare Runs, add human reviews, rescore, reuse configurations, or export the tested agent JSON.

Target agents receive public question text, context, and any published answer format.
New typed table questions derive a public format from declared column names and types, permitting nulls by default.
Typed string and numeric references also derive scalar formats.
Empty-table references expose a generic collection format without revealing that the answer is empty.
Reference rows cannot establish whether the source contains nulls.
JSON imports can supply an explicit `answerFormat`; its null rules cannot exclude nulls allowed by the reference declaration.
Expected values, row counts, and ordering rules remain private, and public nullability does not relax deterministic grading.
Publishing a new bank revision leaves existing revisions and frozen Runs unchanged.
A frozen Run preserves its questions, agent settings, connection settings, evaluator, and limits.
Its manifest does not freeze a live Tableau datasource.

## Use the CLI

The CLI connects to the same local engine as the web interface.
Build the project before using the compiled entry point.
Every command returns JSON; failures return an `error` object and exit with code 1.

```sh
node dist/cli.js discover
node dist/cli.js workspace.get
node dist/cli.js banks.create --file bank.json
node dist/cli.js runs.launch --file launch.json
node dist/cli.js runs.get --file run-reference.json
node dist/cli.js runs.export-agent --file run-reference.json
```

Use `--json`, `--file`, or `--stdin` for command input.
Use `--url http://127.0.0.1:4381` to select an engine endpoint.
`discover` returns operation names and validated JSON input schemas.
The HTTP equivalent is `POST /api/commands/<operation>` with the same JSON input.

A minimal `bank.json` is:

```json
{
  "name": "Sales analytics",
  "questions": [
    { "id": "revenue", "text": "What is total revenue?", "expected": 12500 }
  ]
}
```

A minimal `launch.json` is:

```json
{
  "name": "Baseline",
  "bankRevisionId": "bankrev_REPLACE_WITH_SAVED_ID",
  "agent": {
    "harness": "codex",
    "model": "REPLACE_WITH_DISCOVERED_MODEL",
    "systemPrompt": "Answer the analytics question accurately using the available tools.",
    "tools": [],
    "connections": []
  },
  "repetitions": 1,
  "idempotencyKey": "baseline-request-1"
}
```

An empty tool list exposes no external analytics tools.
Select Tableau tools and a connection binding for analytics work.
Reusing an idempotency key with the same input returns the original Run.
Reusing it with different input is an error.
A run reference contains `{ "runId": "run_REPLACE_WITH_SAVED_ID" }`.
Controls use the same reference plus `"action": "pause"`, `"halt"`, `"resume"`, or `"cancel"`.

## Understand controls and recovery

**Pause** stops new admissions and lets active work finish.
**Halt** interrupts active work and preserves unfinished questions for **Resume**.
**Cancel** interrupts work and makes the owning Run or research session terminal after cleanup.
Controls from a research-owned Run apply to its research session.
Resume starts fresh physical attempts for interrupted questions and preserves completed evidence.
It does not resume an operating-system process.

After a restart, process recovery precedes new admissions.
The engine recovers deterministic assessments from sealed answers when necessary.
Active work becomes paused, halted, or cancelled according to its recorded intent.
A cleanup failure blocks runtime admission and remains visible.

## Revise evaluations

Default grading supports text, exact JSON, decimal numbers, typed answers, and tables.
Typed expected answers also accept equivalent natural JSON numbers, strings, table rows, nulls, and empty arrays.
Typed tables accept lossless JSON-encoded table answers; a declared one-column table also accepts a primitive array as its rows.
These normalizations preserve cell types, values, row counts, duplicates, and configured ordering.
Explicit unanswerable and clarification states remain distinct.
Published evaluator revisions include tolerances, ordering rules, and optional question-specific overrides.
Use reviewed `columnAliases` to map submitted column names to canonical reference names when rescoring saved table answers.
For example, `"columnAliases": { "billing_country": ["country"] }` accepts `country` as an alias for `billing_country`.
Aliases require explicit configuration and cannot excuse wrong values, missing rows, or ambiguous column mappings.
Preview a draft against saved answers before publication.
Configure explicit decimal precision, date semantics, answer extraction, singleton unwrapping, and field-specific rules when the question requires them.
Top-k comparison requires an explicitly complete reference pool and ranking keys.
Calibration cases test accepted variants and wrong answers without another target run.
Publication validates configured cases against the latest bank revision.
Mark a disputed reference as needing review to retain its evidence while excluding it from scored accuracy.
Corrected-reference rescoring accepts an explicit bank revision and records that provenance separately from the original run.
Activation selects the revision for future launches.
Reactivation of an older revision provides reversion without rewriting history.
Rescoring adds another score set and preserves the original evidence and decisions.
Human reviews and optional LLM judge verdicts remain separate from deterministic accuracy.
When a rescore has no new LLM judge assessment, Observe retains the original verdict with the label **Original run judge**.
That verdict uses the original run's judging basis; it does not assess the revised deterministic criteria.

Optional Jev classification adds independent answer, evidence, and reference-quality checks.
Published judging profiles contain editable instructions and criteria.
Saved answers can receive new Jev assessments without another target run.
See [independent judges](docs/judging.md) for evidence handling, profile revisions, and saved-answer judging.

Custom evaluator code is a function body receiving `input.expected` and `input.answer`.
It returns `{ verdict: boolean, explanation?: string, details?: JSON }`.
QuickJS enforces a 100 ms computation limit, 16 MB memory limit, and 64 KB output limit.
The context has no filesystem, network, process, or credential access.
Integrated AI authoring of evaluator criteria is deferred.

## Understand research limits

A research session completes a baseline before opening its provider conversation.
Its initial instructions contain configuration, objective, mutation rules, budgets, and baseline references.
Questions, transcripts, and gold answers require explicit evidence retrieval.
Gold retrieval creates an audit event.
Every subsequent turn retains the exact provider conversation ID.
Unavailable continuity fails the session instead of creating another conversation.

Candidate, invocation, duration, token, and cost limits control further admissions.
Token and cost ceilings are checked between invocations; an active provider request can consume additional usage before returning.
Unknown usage stops research when a configured spending ceiling cannot be evaluated.
Interrupted researcher turns with unknown spending also prevent further admission under a spending ceiling.
Pausing does not reset the session duration budget.

## Maintain the project

Read [the build charter](docs/build-charter.md), [architecture](docs/architecture.md), and [acceptance criteria](docs/acceptance.md).
See [external evaluation targets](docs/external-targets.md) for the proposed HTTP specification, UI design, implementation plan, and future runtime adapter boundary.
Generic HTTP targets are implemented.
Agentforce and other first-class external runtimes remain deferred.
See `docs/http-targets.md` for endpoint configuration and `docs/target-adapters.md` for the internal adapter contract.
See [macOS support](docs/macos-support.md) for the portability specification, implementation plan, and acceptance evidence.
Run `npm run validate` before handing off a substantial change.
It checks formatting, dependency boundaries, types, lint, tests, and the production build.
The architecture check rejects browser imports of backend services and application imports of runtime implementations.
It also separates credential storage from process ownership and confines platform wiring to runtime composition.
CI is configured for Windows, Linux core checks, and macOS 15 on Apple Silicon and Intel with Node.js 22.13.0 and 24.
Configured Mac CI and local POSIX fixtures do not establish native Mac acceptance until those checks run successfully.
Provider tests use bounded calls or local fixtures; ordinary tests do not spend model tokens.
The previous repository is reference material only and is not a dependency.
