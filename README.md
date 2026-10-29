# Agent Evaluation Harness

Agent Evaluation Harness helps you measure how reliably an agent answers your questions, understand its failures, and improve its configuration.
Evaluate the same question bank across models, prompts, tools, and external agents, then compare saved answers and evidence.
Revise scoring and add independent judgments without paying to run the target agent again.

The app combines a local web workspace with a discoverable JSON CLI.
Both use the same engine, saved runs, and evaluation rules.
Tableau MCP supplies analytics tools for managed agents; a generic HTTP adapter supports agents you operate elsewhere.

## What you can do

- Build question banks with expected answers, public context, and versioned grading rules.
- Evaluate managed agents through Codex, Claude Code, OpenCode, or Amazon Bedrock Converse.
- Compare subscription accounts, API connections, and compatible company gateways using the same questions.
- Inspect submitted answers, tool activity, execution failures, scores, and token usage.
- Score saved answers with deterministic rules, an LLM judge, Jev, or an attributed human review.
- Correct disputed references and publish new scores while preserving the original evidence.
- Run bounded research that proposes and evaluates candidate agent configurations.
- Reuse a tested configuration, save a blueprint, or export configuration JSON with credential placeholders.

## Start the app

Use Node.js 22.13.0 or newer and npm.
From this repository, run:

```sh
npm ci
npm run build
npm start
```

Open [the local workspace](http://127.0.0.1:4381).
The default workspace directory is `.aeh`.
Set `AEH_DATA_DIRECTORY` to choose another directory, or `PORT` to choose another server port.
Only one engine can own a workspace at a time.

For a local provider harness, install its CLI separately and make it available on `PATH`.
Sign in through that CLI for subscription access, or save a compatible provider connection in **Settings**.
The built-in Bedrock Converse harness uses a saved Bedrock connection without another agent CLI.

Windows supports native credential storage and provider process management.
macOS implementations are present, but native Mac acceptance remains pending.
Linux supports core tests; live managed-provider execution is not enabled.
See [platform support and remaining checks](docs/macos-support.md).

## Run your first evaluation

1. Open **Settings** to inspect installed harnesses and configure any required connections.
2. Open **Question banks** to create or import questions and expected answers.
3. Open **Run** and choose your agent, bank, question selection, and tools.
4. Keep deterministic grading as the default, or enable independent judges under **Evaluation**.
5. Start the run and inspect its questions, recorded answers, and scores in **Observe**.
6. Open **Results** to compare runs, reuse a configuration, or export it.

For Tableau questions, select a saved Tableau connection and the tools the agent needs.
An empty tool selection provides no Tableau tools.
The agent receives question text, public context, and published answer requirements; expected values remain private.

Each run freezes its selected questions, target configuration, evaluator, and limits.
A run does not freeze a live datasource, so source changes can affect later comparisons.

See [configure and operate evaluations](docs/configuration-guide.md) for accounts, question selection, scoring, human review, recovery, and research.

## Improve answers and scoring

Choose **Score saved answers** to create a named score from recorded answers using different evaluation rules or judges.
Deterministic scoring uses no model calls.
LLM and Jev judging can incur provider usage, but do not rerun the target agent.
Choose **Review judgments** to create an attributed human score while retaining earlier judgments.

Accuracy means correct answers divided by completed correct-or-incorrect judgments.
Completion, judgment coverage, execution failures, and unavailable judgments remain separate.
Research uses a fixed eligible question count and rejects reduced coverage, so failed questions cannot improve selection by shrinking the denominator.

Performance separates **Input tokens (uncached)**, **Output tokens (generated)**, and **Cache tokens (reused input)**.
Reported subtotals remain visible while other requests are pending or lack usage reports.
Repeated conversation context counts each time the provider processes it, so a run can use more tokens than one question's context limit.

## Use the CLI

The CLI connects to the running local engine.
Start with help and the command catalog:

```sh
npm run cli -- --help
npm run cli -- discover
npm run cli -- workspace.get
```

For scripts, use the compiled entry point to receive JSON without npm's script banner:

```sh
node dist/cli.js --help
node dist/cli.js discover
node dist/cli.js banks.create --file bank.json
node dist/cli.js runs.launch --file launch.json
node dist/cli.js runs.get --file run-reference.json
```

`discover` returns operation names and validated JSON input schemas.
Use `--file`, `--json`, or `--stdin` for input, and `--url` or `AEH_URL` to choose a local engine.
See [CLI examples](docs/cli.md) for bank, launch, control, scoring, review, research, and export workflows.

## Local data and credentials

Runs, answers, and evidence are saved in the local workspace.
Provider and external-agent requests still leave your machine according to your configuration.
Treat saved traces and exports as potentially sensitive business data.

Store credentials in **Settings**, rather than prompts or advanced JSON.
Connection secrets use Windows DPAPI or macOS Keychain through a separate machine-local store.
Moving a workspace preserves its evidence but requires entering credentials again.
Provider subscription sign-in also belongs to each machine.
Configuration exports use credential placeholders and omit the question bank and expected answers.

## Documentation

- [Configure and operate evaluations](docs/configuration-guide.md): accounts, runs, scoring, review, research, and reuse.
- [CLI examples](docs/cli.md): discovery and automation through the shared engine.
- [Independent judges](docs/judging.md): LLM and Jev assessments, evidence, and published profiles.
- [External HTTP agents](docs/http-targets.md): endpoint configuration, mapping, and remote-work limits.
- [Evaluator design](docs/evaluator-design.md): comparison policies and calibration.
- [Architecture](docs/architecture.md): engine boundaries, immutable evidence, and lifecycle ownership.
- [Architecture audit](docs/architecture-audit.md): current source coverage, findings, and verification limits.
- [Delivery validation record](docs/observation-redesign-validation.md): historical checks for the observation work.

## Develop and validate

Run `npm run dev` and `npm run dev:web` in separate terminals.
The development interface uses port 5181 and forwards API requests to port 4381.

Run `npm run validate` for formatting, architecture boundaries, types, lint, tests, and the production build.
Ordinary tests use local fixtures and do not spend model tokens.

Install the local pre-push gate in each checkout after installing dependencies:

```sh
npm ci
npm run hooks:install
```

Commit or stash changes, keep the checkout idle, and push your checked-out branch normally.
The hook runs `npm run validate` locally before Git sends updates and reports the validated commit.
It rejects dirty files, submodule changes, unrelated outgoing commits, and changes detected during validation.
Tags must resolve to HEAD; push other branches from their own checked-out commits.
Deletion-only pushes skip validation.
An existing conflicting `core.hooksPath` stops installation without replacing your hooks.
Custom files in Git's default hooks directory also stop installation; integrate those hooks before installing the gate.

This gate uses your machine and requires no GitHub Actions minutes, account upgrade, or hosted runner.
It validates only your local platform and Node.js version; native Mac acceptance remains separate.
GitHub does not enforce local hooks, and clones need their own installation.
See [local gate guarantees](docs/architecture.md#build-tooling-and-change-placement) for details and limits.

Read the [build charter](docs/build-charter.md), [architecture](docs/architecture.md), and [acceptance criteria](docs/acceptance.md) before substantial changes.
The previous repository is reference material only and is not a dependency.
