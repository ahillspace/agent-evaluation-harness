# Repository instructions

Use TypeScript and Node.js 22.13.0 or newer.
Use the talk skill for human-facing communication.
Use plain dashes instead of em dashes in human-facing writing.
Delegate independent work using capable agents when useful.
Do not invoke no-mistakes, create commits, push, or send external messages without explicit authorization.

## Architecture

Read `docs/build-charter.md`, `docs/architecture.md`, and `docs/acceptance.md` before substantial changes.
Use `docs/architecture-audit.md` for the reviewed baseline, known gaps, and validation limits.
Keep architectural truth in its canonical documentation owner rather than repeating it here.
The application layer owns all product rules and lifecycle decisions.
The CLI and HTTP server call the same application operations.
React owns presentation and draft form state.
The runtime owns provider processes, connections, and secret resolution.
The evaluator reads sealed evidence and never invokes the target agent.
Question banks, evaluators, agent manifests, and evidence are immutable after publication or launch.
Do not introduce Study, Experiment, or Campaign execution hierarchies.

## Engineering

Add behavior tests before changing nontrivial behavior.
Start bug fixes with an end-to-end reproduction when practical.
Keep modules focused and prefer concrete modules over speculative frameworks.
Never edit generated files, including `package-lock.json`, build output, or changelogs.
Put each full sentence on its own physical line in long Markdown documents.
Never add agent co-authors to commits.
The old `tableau-mcp-autoresearch` repository is reference material only.
Do not import, symlink, edit, or delete its files or data.

## Checks

Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` for substantial changes.
`npm run validate` also runs formatting and production import-boundary checks.
Maintained TypeScript scripts participate in type checking; verify their workflows in isolated workspaces when changing them.
For documentation changes, check formatting, local links and anchors, source claims, and navigation.
Use bounded local tests before costly provider calls.
Record actual validation and limitations; never claim unexecuted checks passed.
