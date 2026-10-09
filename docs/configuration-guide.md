# Configure and operate evaluations

An evaluation run records how one frozen agent configuration answers selected questions.
Use the same bank across runs to compare configurations, and inspect evidence before changing the agent or scoring rules.

## Set up accounts and connections

Open **Settings** to inspect installed harnesses and manage reusable connections.
Discovery reports installed software, detected authentication, and available models when the provider supplies a catalog.
A listed model does not establish that your account has permission to use it.

| Harness                 | Authentication                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| OpenAI Codex            | Local Codex sign-in for subscription access, or a saved OpenAI connection.                           |
| Anthropic Claude Code   | Local Claude Code sign-in for subscription access, or a saved Anthropic connection.                  |
| OpenCode                | Local OpenCode authentication, or a compatible OpenAI, Anthropic, OpenRouter, or Bedrock connection. |
| Amazon Bedrock Converse | A saved Bedrock connection with a region and bearer token.                                           |

Install local harness CLIs separately and keep them on `PATH` when starting the engine.
Store API keys and bearer tokens in **Connections**, then choose the connection for the target, researcher, or judge that needs it.
These roles can use different providers and models.

### Connect through a company gateway

Choose the provider whose API protocol the gateway implements and enter its base URL.
For an Anthropic-compatible gateway, select Anthropic and its API-key or bearer authentication mode.
For a Bedrock gateway, supply the region and bearer token, and set the optional gateway URL.
Enter the gateway's model ID if it does not expose a model catalog.
Set `NODE_EXTRA_CA_CERTS` to a trusted PEM bundle path before starting the Node engine when Bedrock or managed child harnesses need a company CA.
Node reads this setting at process startup.

The built-in Bedrock Converse harness uses non-streaming requests.
OpenCode's Bedrock integration requires ConverseStream support.
Connection discovery does not prove that a gateway accepts every model or invocation feature.

### Connect Tableau tools

Create a Tableau connection for the intended server and site, then test it from **Settings**.
In **Run**, select the connection and allowed actions under **Tools**.
The engine manages the Tableau MCP process; an empty tool selection exposes no Tableau tools.
When you check a connection or run with Tableau tools, the harness starts a local stdio MCP process using the saved Tableau server, site, and token.
By default, it runs `npx -y @tableau/mcp-server@4.13.3`.
If the package is not installed or cached locally, `npx -y` fetches it into npm's cache and runs it without a confirmation prompt.
This is an on-demand cache install, not a global install.
The harness does not attach to an already-running MCP server or use servers configured in Codex, Claude Code, or OpenCode.
To use another Tableau MCP version, change the package spec in `mcpArgs` under **Tableau MCP settings (JSON)**.
To use another compatible local server, set `mcpCommand` and `mcpArgs`.
The machine running the harness needs Node.js/npm and npm access for an uncached package.
The web editor's **Tableau MCP settings (JSON)** accepts `mcpCommand`, `mcpArgs`, `mcpEnv`, and `mcpFeatures`.
This object configures the local process; it is not a JSON request sent to the MCP server.
The runtime communicates over stdio and supplies Tableau authentication through its launch environment.
A compatible custom server must implement stdio MCP and accept these harness-managed environment variables:

| Variable                    | Value                                                           |
| --------------------------- | --------------------------------------------------------------- |
| `TRANSPORT`                 | `stdio`                                                         |
| `AUTH`                      | `pat`                                                           |
| `SERVER`                    | The saved Tableau server URL.                                   |
| `SITE_NAME`                 | The saved site content URL.                                     |
| `PAT_NAME`                  | The saved personal access token name.                           |
| `PAT_VALUE`                 | The secret personal access token value.                         |
| `INCLUDE_TOOLS`             | Selected tool names as a comma-separated list, when restricted. |
| `ENABLE_MCP_SITE_SETTINGS`  | `false`                                                         |
| `PRODUCT_TELEMETRY_ENABLED` | `false`                                                         |
| `DISABLE_LOG_MASKING`       | `false`                                                         |

Use `mcpEnv` for additional MCP server environment variables as string values.
This lets a connection use server options added in another Tableau MCP version without a harness update.
Variable names retain their exact spelling and case, and values pass through literally without shell expansion.
Use the spelling expected by the MCP server, and do not supply two names that differ only by case.
Use strings for all values, including numbers, booleans, and serialized JSON.
The harness reserves authentication, transport, telemetry, tool selection, and its internal feature override variable.
These are public settings saved with connection and run configurations.
Do not put credentials in `mcpEnv`; use the protected credential field.

For example, set `mcpEnv` to `{"INCLUDE_DATASOURCE_IDS":"id-1,id-2"}` to bound Tableau MCP tool requests and results to those datasource IDs.
The PAT authenticates to Tableau, and the MCP datasource filter bounds the resources available through this connection.
Tableau documents datasource scoping in its [self-hosted deployment guide](https://tableau.github.io/tableau-mcp/docs/enterprise/tableau-server).
`INCLUDE_TOOLS` is controlled by the tool allowlist in **Run**.

Use `mcpFeatures` for feature flags as a map of feature names to booleans.
The harness overlays these values on the defaults shipped by the selected Tableau MCP package through Tableau MCP's custom feature gate provider interface.
Feature names stay user-configurable so new Tableau flags do not require a harness release.
See Tableau's [feature flag documentation](https://tableau.github.io/tableau-mcp/docs/developers/feature-flags) for the current provider behavior.

For example, set `mcpFeatures` to `{"knowledge-tools":true}` to enable Tableau Knowledge tools in packages that support that flag.
The site must have Tableau Knowledge enabled, and the feature is available on Tableau+ sites.
Query and inspect require Viewer or higher; manage requires Creator or higher and can change shared Knowledge context.
Select only the Knowledge tools the agent should use in **Run**.
See Tableau's [Knowledge query](https://tableau.github.io/tableau-mcp/docs/tools/knowledge/query-knowledge-context), [inspect](https://tableau.github.io/tableau-mcp/docs/tools/knowledge/inspect-knowledge-context), and [manage](https://tableau.github.io/tableau-mcp/docs/tools/knowledge/manage-knowledge-context) documentation.

Keep datasource references consistent across the question context, system prompt, and datasource setting.
A datasource ID in the Run setup provides prompt guidance.
Use `mcpEnv.INCLUDE_DATASOURCE_IDS` when the MCP connection must enforce a datasource boundary.
Requests sharing a Tableau session credential can wait for that connection even when the run permits additional concurrency.

## Create a question bank

Open **Question banks** to create a bank or import validated JSON or CSV.
Give each question a stable ID, clear text, and an expected answer.
Use tags to organize subsets and public context to supply information the agent needs.

References can contain scalar values, JSON, or typed tables.
Typed declarations derive public answer formats without disclosing expected values or row counts.
Imports can supply an explicit `answerFormat`.
Published evaluation requirements describe applicable representation, duplicate, and ordering rules.

Publishing edits creates another bank revision.
Existing runs retain their original questions, references, and grading settings.

Expected-answer size indicators estimate tokens from serialized content.
Yellow starts at approximately 2,000 tokens; red starts at approximately 32,000 tokens for the relevant Jev context estimate.
Judge requests also contain the submitted answer, instructions, and evidence, so a smaller reference does not guarantee that the complete request fits.

## Configure and launch a run

Use the setup sections in **Run**:

1. Choose **Agent under test**, then select a managed harness or saved external HTTP agent.
2. Select the model, account or connection, and system prompt for a managed agent.
3. Choose a bank and question subset under **Questions**.
4. Select the permitted Tableau actions under **Tools**, when needed.
5. Choose repetitions, concurrency, time limits, and optional judges under **Evaluation**.
6. Review the configuration and start the run.

Question filters cover search text, answer type, tags, and estimated answer size.
Filtering changes visibility, not your existing selection.
Use **Select filtered**, **Deselect filtered**, or individual checkboxes to change selected questions.

A repetition evaluates every selected question again.
Concurrency controls simultaneous admissions; provider and connection limits can reduce actual parallel work.
Advanced JSON editors describe supported settings and validate input.
Put credentials in **Connections**, not advanced JSON or prompts.

Setup drafts survive navigation and refresh within the same tab and workspace.
**Reset** discards the draft, and a successful launch clears it.
Unavailable saved dependencies stay visible so you can replace them deliberately.

For external agents, configure request and response mapping in **Settings**.
Request preview does not call the endpoint; an explicit sample request does.
See [external HTTP agents](http-targets.md) for configuration and evidence limits.

## Inspect answers and scores

**Observe** opens the question list.
Select a question to inspect its submitted answer, reference, attempts, recorded activity, and judgments.
Use **Summary** for run-level outcomes and performance.
Execution failures and judge errors remain distinct from incorrect answers.

Choose a named saved score to inspect its judgments and coverage.
Accuracy is `correct / judged`, where judged means a completed correct-or-incorrect decision.
Coverage shows how many eligible questions received those judgments.
Excluded questions, unanswered questions, errors, and abstentions are reported separately.

| Display                     | Meaning                                                        |
| --------------------------- | -------------------------------------------------------------- |
| Input tokens (uncached)     | Input the provider did not report as a cache read.             |
| Output tokens (generated)   | Generated output, including reported reasoning tokens.         |
| Cache tokens (reused input) | Input served from cache, shown separately from uncached input. |

The engine normalizes provider-specific counters before presenting these quantities.
Uncached input plus reused input equals inclusive input when the provider reports both components.
Missing cache data does not mean zero cache usage.
Known subtotals remain visible with separate counts for pending and unreported requests.
Failed requests contribute usage when the provider reports it.

Repeated prompts, instructions, tool definitions, conversation history, and tool results can contribute input across several model calls.
Token totals therefore measure processed traffic, not the size of a single context window.
Research usage counts decisions made after the selected run, with cumulative conversation reports converted to deltas.

## Score saved answers

Choose **Score saved answers** to create a named score.
Select deterministic rules, an LLM judge, or Jev, then choose the applicable evaluator or reference revision.
The operation reads saved answers and does not rerun the target agent.

Deterministic grading is the default and uses no model calls.
Optional settings cover numeric tolerance, text normalization, answer representation, duplicate rows, column aliases, and explicit ordering and collation.
Use strict representation when the submitted format is part of the requirement.
Use compatible representation when lossless supported conversions are acceptable.
Keep duplicate-preserving comparison when repeated rows have meaning.
Specify ordering requirements explicitly when row sequence matters.

Under the bank's evaluator controls, preview a draft against saved answers and check calibration examples before publishing it.
Publishing creates an immutable evaluator revision; activation chooses the default for future launches.
Select a corrected bank revision when the reference itself changes.

LLM judges return an independent verdict and can abstain when the evidence is insufficient.
Jev adds answer, evidence, and reference-quality classifications with recorded confidence information.
Configure their accounts, instructions, and evidence requirements independently from the target agent.
These operations can incur provider usage.
See [independent judges](judging.md) for profile configuration and saved evidence.

Oversized or rejected judge requests appear as not judged with a specific error.
The engine preserves response evidence and does not silently truncate requests to create a verdict.
Use **Retry missing scores** after resolving judge failures; this creates another saved score.

## Review judgments and reference issues

Choose **Review judgments** on the selected score to record human decisions and notes.
The new human score retains unchanged judgments and links to its parent.
Original computed scores remain available.

For a suspected reference, wording, duplicate, or datasource problem, report a finding from question details.
Open the bank's **Findings** section to inspect source evidence, accept it, or dismiss it.
An accepted correction can publish a new reference revision.
An exclusion can publish evaluator rules that mark the question as needing review.
Existing scores keep their original question counts; score saved answers again to apply the revised basis.

## Control and recover work

| Control | Result                                                                          |
| ------- | ------------------------------------------------------------------------------- |
| Pause   | Stops admitting new work and lets active requests finish.                       |
| Halt    | Interrupts active work and retains unfinished questions for resume.             |
| Resume  | Starts fresh attempts for unfinished questions and preserves completed answers. |
| Cancel  | Interrupts work and makes the run or research session terminal after cleanup.   |

Controls on a research-owned run apply to the research session.
Resume does not restore an operating-system process.
After a restart, the engine reconciles interrupted work before admitting new requests.
A cleanup failure remains visible and blocks unsafe admission.

Eligible transient failures receive at most three total attempts: the initial attempt and two delayed retries with increasing backoff and jitter.
The runtime must establish that repetition is safe.
For native Codex capacity rejection, complete terminal evidence can establish that no work started, even when tools are configured.
Tool activity, uncertain execution, and external HTTP requests prevent automatic repetition.
Permanent authentication or configuration errors stop further admission instead of repeatedly retrying.

After active work settles, **Rerun failed questions** creates a linked run containing only failed question and repetition slots.
It uses the original frozen configuration and retains the original attempts and scores.
When prior actions could repeat, the app requires acknowledgment.
Incorrect answers do not trigger automatic execution retries.

## Run bounded research

Enable **Research** while configuring a managed-agent run.
Choose a researcher, write its instructions, and specify permitted changes and budgets.
Set the selection metric to deterministic, LLM, or Jev; enable the corresponding judge before launch when required.

The baseline completes before the researcher starts.
Each candidate launches an ordinary run with the same frozen evaluation basis.
The researcher keeps one provider conversation and retrieves detailed evidence when needed.
Explicit requests for expected answers are audited.

Candidate disposition and session control are independent.
The researcher can keep an evaluated candidate and stop, or discard it and continue.
Candidate selection uses a fixed eligible denominator and rejects lower judgment coverage.
Unavailable judgments cannot improve a candidate by reducing the number of scored questions.

**Allow early stop** controls voluntary stopping, and optional stop guidance describes your preferred stopping conditions.
When disabled, lack of improvement alone does not end research.
Hard budgets, cancellation, and concrete technical blockers can still stop it.
The candidate budget excludes the baseline.

Invocation, duration, researcher-turn, token, and cost budgets constrain further admissions.
Token and cost ceilings are checked between invocations, so an active request can consume additional usage before returning.
Missing usage stops research when the engine cannot evaluate a configured spending ceiling.
Pause does not reset the duration budget.
Provider conversation continuity failure stops the session instead of opening another conversation.

## Compare, reuse, and export

Open **Results**, select runs, and choose **Compare**.
Choose each run's saved score deliberately and inspect comparison warnings for different evaluation bases.
Keep accuracy, coverage, and execution completion visible when choosing a configuration.

Choose **Reuse** to copy a run's configuration into setup without launching work.
Research-run reuse also restores its research configuration.
Choose **Save blueprint** to retain reusable launch settings, then **Use blueprint** for another setup.

Choose **Export JSON** to obtain the frozen tested target configuration.
Managed exports include resolved agent settings and credential placeholders.
External exports describe endpoint configuration rather than the remote agent's internal implementation.
Exports omit private expected answers and secrets.
Configure credentials and any required provider or tool environment before using an exported configuration elsewhere.

Use [the CLI](cli.md) to automate these workflows against the same engine.
