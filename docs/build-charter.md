# Build charter

Agent Evaluation Harness evaluates managed agents and external agent systems through one headless engine and a React interface.
The initial connection provider is Tableau MCP.
The engine treats connections as provider bindings and contains no Tableau-specific query logic.

## Product workflow

Question banks holds questions, expected answers, and versioned evaluators.
Run contains Setup and Observe.
Results compares saved executions, supports review and rescoring, and exports tested agent configurations.
Settings manages external agents, connections, and local runtime discovery.
A Run evaluates one frozen target configuration against selected questions for one or more complete repetitions.
A blueprint saves reusable launch settings.
An optional research session evaluates a baseline and proposes candidate configurations through one persistent provider conversation.
Each candidate uses the ordinary Run contract.

## Required behavior

- Freeze bank content, evaluator settings, and resolved agent configuration before execution.
- Keep gold answers out of target prompts, runtime target inputs, and exported agent configurations.
- Record deterministic grading independently of optional model judging and human review.
- Support independent LLM and Jev judges, including editable bank-level Jev profiles and complete recorded attempt evidence.
- Preserve judge requests, responses, configuration, and model provenance when judging saved evidence.
- Save named assessment passes automatically and reopen their evidence without another provider or target invocation.
- Preserve original evidence and assessment passes when reevaluating saved answers.
- Preview evaluator drafts before publishing; activation and reversion never rewrite existing runs.
- Support graceful Pause, immediate Halt, resumable interruption, and terminal Cancel.
- Persist live observation and cursor-based event history before publishing updates.
- Export the tested agent JSON from every saved Run with credential placeholders.
- Provide discoverable JSON CLI operations using the same application contracts as HTTP.
- Keep one exact researcher conversation; continuity failure stops research instead of replacing it.
- Expose gold answers to research only through explicit, audited retrieval.
- Bound subprocesses, evaluator code, repetitions, and research spending.

## Scope boundaries

The project starts in a new repository and has no compatibility obligation to historical development runs.
The prior repository and its data remain untouched.
Integrated AI authoring of evaluator criteria is deferred.
Its future interface creates a draft, previews changes, and publishes a revision through existing operations.
Microservices, a generic workflow framework, and mandatory study hierarchies are outside scope.
No external messages, pushes, commits, or unbounded paid provider calls are authorized by this charter.
