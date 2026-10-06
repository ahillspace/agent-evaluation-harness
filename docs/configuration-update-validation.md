# Configuration and recovery update validation

This report records the configuration and recovery checkpoint before the observation redesign.
See [Observation redesign validation](observation-redesign-validation.md) for the later implementation and its delivery state.

## Implemented scope

- Plain-language section help, viewport-contained help dialogs, and nested table containment.
- Shared JSON references with examples, supported keys, defaults, and validation feedback.
- Tab-local, workspace-scoped setup persistence through navigation and reload.
- Unified run and blueprint reuse with researcher configuration restoration.
- Automatic model and tool discovery with request-scoped responses and errors.
- Question search, answer types, tags, select all, deselect all, and filtered selection.
- Settings as the primary home for credentials, with compatible saved selections in Run.
- OpenAI Codex, Anthropic Claude Code, OpenCode, and direct non-streaming Bedrock Converse.
- Anthropic bearer authentication and company Bedrock gateway bearer authentication.
- Visible research activity and independent execution-failure reporting.
- Safe automatic retry admission and explicit linked retry runs without changing original evidence.

## Executed checks

The final ordinary test suite passed 377 tests, with 12 skipped.
TypeScript, ESLint, Prettier, architecture checks, and the production build passed.
Architecture checks covered 129 production modules.
Independent review corrected retry concurrency admission, credential selection restoration, workspace draft isolation, stale discovery errors, and Bedrock settings validation.

Browser checks reproduced the original nested-table overflow and verified the corrected table fits inside its card.
Jev form fields fit inside the viewport, and help opens in a dialog outside panel clipping.
Agent model and prompt persisted through Settings navigation and browser reload.
The full 112-question Spider selector supported deselection and selecting one filtered question.
Reusing a recorded research candidate restored the Luna researcher, instructions, and automation limits.

Installed OpenCode passed local HTTP fixtures for Anthropic bearer authentication and Bedrock streaming authentication.
The direct Bedrock runtime passed a non-streaming local HTTP fixture with real supervised answer-submission MCP, researcher continuity, independent judging, failure handling, redirects, and response bounds.
These fixtures made no paid provider calls.

## Limitations and deployment state

Claude Code is not installed on this machine, so its adapter has fixture coverage rather than a live CLI validation.
No company gateway credential was supplied for a live gateway check.
Native macOS validation remains a release requirement.

Automatic approval review initially blocked restarting the existing review server on port 4393.
Browser persistence checks used an isolated database copy on port 4394 without copied credentials.
After the user explicitly requested launch, port 4393 restarted successfully with the updated backend.
The workspace identity, all 112 Spider questions, and three saved connections were confirmed through the application API.
No commit or push was made.
