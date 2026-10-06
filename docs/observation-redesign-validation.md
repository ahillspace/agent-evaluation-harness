# Observation redesign validation

## Delivered behavior

Runs support named deterministic, LLM, Jev, and human assessment passes over saved answers.
Each pass freezes its reference and judging configuration, preserves coverage and errors, and supports reopening and export.
Retry carries completed judgments forward and evaluates only failed or unfinished judgments with sealed answers.
Human review preserves untouched judgments and records overrides, notes, reviewer identity, and review coverage.

Results shows one row per Run with a remembered assessment selection.
Live and saved Runs open on Questions, followed by Summary, conditional Research, and Configuration.
Accuracy uses correct answers divided by completed correctness judgments, with execution and judgment coverage shown separately.
Research selection retains the fixed eligible objective and coverage guard.
Performance separates target, researcher, and judge activity and preserves reported subtotals alongside pending and unreported counts.
Normalized provider input includes cached input as a subset.
The interface separates uncached input, generated output, and reused cache tokens.

Question banks and Run setup show expected-answer size estimates and advisory Jev capacity warnings.
Question findings link saved evidence and require explicit acceptance before publishing corrections or exclusions.
Evaluator policies cover representation, numeric and text comparison, ordering, collation, and duplicate rows.
Research records candidate disposition separately from continuation, and exposes early-stop policy and fixed selection coverage.
Execution retries retain physical attempts and require evidence that retrying is safe.
The app includes a visible build identifier.
The analytics dashboard remains outside this redesign.

## Initial redesign checkpoint

The following checks and browser observations describe the initial delivery before the accuracy and usage correction below.

### Executed checks

The complete validation checkpoint passed formatting, architecture checks, TypeScript, ESLint, tests, and the production build.
Architecture checks covered 142 production modules.
The final test suite passed 393 tests and skipped 12 across 81 files, with 79 files passing and two skipped.
The production frontend build transformed 103 modules.

A focused regression reproduced oversized comparison evidence leaking into observation summaries.
The fix excludes comparison details, raw requests, and responses from observation projections, and removes result-slot arrays from Run assessment summaries.
Deliberate pass reads and exports retain the full evidence.
After this fix, all 19 focused assessment, storage, and presentation tests passed, and TypeScript passed.
The final complete validation then passed again, including this regression and the production build.

Bounded fixtures verify named pass persistence, failed execution notes, selective judgment retry, fixed eligible coverage, interrupted-pass recovery, immutable evidence, and explicit reference correction.
Recovery preserves completed abstentions instead of converting them into failed judgments that incur another provider call.
Fixtures also cover independent keep and stop decisions, early-stop policy, delayed safe retries, submission failures, and Jev token-limit errors.
These checks use local fixtures and make no paid target, researcher, or judge calls.

### Browser evidence

Browser checks used the isolated redesign preview workspace.
The selected assessment remained selected after reload.
Human review saved a derived score.
Deterministic reevaluation saved another assessment without rerunning the target.
Accepting a question finding explicitly published reference revision 2.
The question selector displayed both yellow size warnings and red estimated-capacity warnings.
The final responsive checks at viewport widths of 375 and 1265 pixels confirmed that the interface fit both layouts.
These responsive checks used frontend build 2026-10-05T23:04:10.457Z before the final production rebuild.

### Server and delivery state

Automatic approval review initially rejected a process-termination request.
After explicit user authorization, the existing processes stopped successfully and both servers restarted from the final build.
The user workspace runs on port 4393 in process 57848, and the isolated preview runs on port 4395 in process 25724.
Both independently reported build identifier 2026-10-05T23:08:02.372Z through the build API.

Read-only API checks confirmed that selected assessment IDs agree between workspace and Run detail responses.
Observation projections omit comparison details and raw judge requests and responses.
Run summaries omit result-slot arrays, while deliberate pass reads retain the complete reference configuration and eligible slots.
The user workspace retains 15 Runs, three banks, three saved connections, and seven research sessions.
Its Runs comprise nine completed, four halted, and two cancelled records; its research sessions comprise two completed, four halted, and one failed record.
No work is active, and halted records remain resumable.
The isolated preview contains two Runs and two banks.

Fresh-backend browser checks on port 4393 confirmed the connected engine, final build identifier, and all 15 saved Runs.
The latest candidate displays an outcome of 51.4 percent, representing 18 correct answers across 35 eligible questions.
Its 31 judged answers, four execution failures, and separate judged accuracy of 58.1 percent remain visible.
Overview exposes performance, review, and reevaluation actions.
Research shows the two recorded turns, retained baseline, current candidate, and stopping reason.
These browser checks recorded no console errors, and the user workspace tab was marked as the deliverable.
No commit or push was made.

The earlier configuration and recovery report describes a separate historical checkpoint.
Native macOS validation and live checks against unavailable provider installations or credentials remain outside the recorded fixture evidence.

## Accuracy and usage correction checkpoint

The complete validation passed formatting, architecture checks, TypeScript, ESLint, tests, and the production build.
The suite passed 403 tests and skipped 12 across 83 files, with 81 passing files and two skipped files.
Architecture checks covered 142 production modules, and the frontend build transformed 103 modules.
Focused regressions cover partial usage, original and retried judge requests, completed abstentions, cached input, and fixed research selection coverage.
Independent code review found no remaining blocker in this scope.
UI review confirmed judged accuracy, separate coverage, partial totals, and included cached input.
These checks use fixtures and make no paid model calls.

Both servers restarted after the active user Run completed.
Read-only build API checks independently confirmed build 2026-10-06T06:23:20.090Z on user port 4393, process 25208, and preview port 4395, process 51136.
Read-only Run detail checks confirmed the latest user Run is completed with 33 answered questions, two execution failures, and three original assessment passes.
Deterministic accuracy is 21 / 33, or 63.6 percent; LLM accuracy is 18 / 30, or 60 percent; Jev accuracy is 16 / 16, or 100 percent.
Jev separately reports seven assessment errors and 12 unjudged questions.
These rates derive from frozen counts without rewriting historical assessment evidence.

Target usage reports 2,992,272 input tokens and 23,740 output tokens across all 35 attempts, including failed attempts.
Judge usage preserves 512,466 input tokens and 5,004 output tokens from 59 reports, with seven unreported invocations shown separately.
The historical Run has no persisted cached-input breakdown: target reports 35 unreported cache fields and judges report 66.
Its known inclusive input totals remain accurate; new executions persist cached input separately as a subset.
No commit or push was made.

### Final browser verification

The final frontend build is 2026-10-06T06:25:30.839Z.
Backend code remains on the verified build 2026-10-06T06:23:20.090Z with unchanged processes 25208 and 51136.
Browser checks confirmed Questions opens by default, Summary is second, and all assessment scores remain visible with separate coverage.
The user workspace shows the three original scores and stable target and judge token totals described above.
Preview checks exercised nine saved scores and partial usage labels.
Reported subtotals of 240 and 40 remain visually separate from their two reported and one unreported invocation labels.
Layouts fit viewport widths of 375 and 1265 pixels without page overflow.
The user workspace reloaded the final frontend and remains open on Questions.
No browser console errors were recorded in the preceding complete user-workspace check.

## Final ship checkpoint on 2026-10-06

The final `npm run validate` completed successfully with exit code 0.
Formatting, architecture checks, TypeScript, ESLint, tests, and the production build all passed.
The suite passed 410 tests and skipped 12; 83 test files passed and two were skipped.
Architecture checks covered 143 production modules, and the frontend build transformed 103 modules.
These validation checks used local fixtures and made no paid model calls.

### Token reporting and browser checks

The interface now labels input as uncached, output as generated, and cache as reused input.
The verified historical user Run displays 661,136 uncached input tokens, 23,740 output tokens, and 2,331,136 cache tokens.
Uncached input and cache sum to the unchanged inclusive input total of 2,992,272.
Historical cache recovery reads bounded native usage events and requires their inclusive input and output totals to match the sealed record.
It does not rewrite saved evidence or infer zero when cache data is unavailable.
Pending and unreported usage remain distinct from known subtotals.

Browser checks passed at desktop width and 375 pixels.
The checks covered **Score saved answers**, **Review judgments**, **Rerun failed questions**, and the separate token labels and help.
Questions remains the default observation view, followed by Summary.

### Documentation and repository cleanup

The README now starts with the product's value and provides setup, first-run, and CLI instructions.
The workflow guide covers provider accounts, gateways, scoring, human review, recovery, research, comparison, and reuse.
The CLI guide uses discovery as the authoritative schema reference and supplies file-based examples.
The obsolete interactive rebuild prototype and completed HTTP build plan were removed; current architecture, HTTP instructions, and dated verification records remain.
Ignore rules now cover local environment files, common private-key files, and database files and sidecars.
The ignore audit found no tracked source fixtures affected by these rules.
A pattern scan found no matching provider tokens, private-key blocks, or Slack webhook URLs in tracked or nonignored files.
This pattern scan does not establish the absence of every possible secret.
No run or workspace data was deleted.

### Remaining platform evidence and delivery state

A previous native macOS CI cleanup failure remains unresolved at this checkpoint.
The bounded CI update enforces LF line endings, gives the serial process-scope test an explicit deadline, and preserves the concrete watchdog cleanup error.
A leader-retention regression passes existing behavior without a timer change; the suspected timer cause was not reproduced.
No speculative process-lifecycle fix was applied.
Local green checks do not establish native macOS acceptance.

Commit and push are authorized and pending when this checkpoint is recorded.
Subsequent remote CI results require their own recorded outcome.
