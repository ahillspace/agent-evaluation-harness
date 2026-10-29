# Luna Jev reliability

## Campaign objective

Complete one clean 50-question target run with zero harness failures and zero Jev judgment failures.

Target answer correctness is diagnostic and does not determine campaign success.

A refused answer or a missing `submit_answer` result counts as a reliability failure.

Use no LLM judge and no research agent.

Run-by-run independent Luna review is required after each provider-backed batch.

The campaign has an authorized ceiling of 20 provider-backed test batches, including any rejudging batch.

## Baseline configuration

The exact baseline request is [`baseline.json`](../.aeh/luna-jev-reliability/baseline.json).

The selected bank revision is `bankrev_df8acee6-5c1f-4de8-ae6f-40e1aeb40eff`, with 50 unique question IDs.

The set contains all 35 questions from the latest 35-question run, including prior target failures `q019` and `q109` and prior large-output questions.

It adds 15 questions for broader query coverage and additional output sizes.

The target is Codex `gpt-6-luna` with low reasoning effort, 40 turns, concurrency one, a 300-second timeout, and a 16 MB answer cap.

The target gets the read-only Tableau discovery, metadata, and query tools.

The launch configuration does not pin a datasource LUID or include copied datasource metadata.

Jev uses the bank's active profile and saved Jev connection.

The LLM judge is disabled.

## Run log

Baseline batch 1 of 20 launched at 2026-10-07 21:08 UTC.

Provider-backed batch count: 9 of 20.

| Batch                     | Run or pass ID                              | Target completion | Target failures | Jev errors / usable verdicts | Luna review | Outcome                                     |
| ------------------------- | ------------------------------------------- | ----------------: | --------------: | ---------------------------: | ----------- | ------------------------------------------- |
| Baseline                  | `run_23321bfb-9817-41aa-aa35-2d6797ab7eb6`  |    10/50 executed |               0 |          4 errors / 4 usable | Complete    | Canceled after drain                        |
| Saved-answer Jev rejudge  | `pass_3ee18dac-4e55-40b5-95cc-d640e6c52d38` |  10 saved answers |  Not applicable |          0 errors / 0 usable | Complete    | No usable verdicts                          |
| Answer-only Jev rejudge   | `pass_d1debd2d-b785-4c5b-8268-ac707bac797a` |  10 saved answers |  Not applicable |          0 errors / 8 usable | Complete    | 2 below threshold                           |
| Full 50 target run        | `run_7a05edf9-be3c-4afa-92d7-735f1f893da6`  |    50/50 executed |               0 |         4 errors / 37 usable | Complete    | Reliability goal not met                    |
| Supplemental 25           | `run_9c53662e-feaf-497b-a88e-d8b25eefb780`  |    25/25 executed |               0 |         0 errors / 21 usable | Complete    | 4 below threshold                           |
| Final verification 50     | `run_b0b7e3a0-d927-489a-97a3-bba4c64df74e`  |   49/50 completed |               1 |         0 errors / 46 usable | Complete    | 3 abstentions; q108 failed                  |
| q108 linked retry         | `run_7e8dec17-dbea-4309-aec0-4cae16207420`  |     1/1 completed |               0 |          0 errors / 1 usable | Complete    | Acceptable at 0.94; original run unchanged  |
| Final verification v2     | `run_e32f8cd9-46d6-430e-aee3-ff7d7ab4b5b7`  |   50/50 completed |               0 |         2 errors / 47 usable | Complete    | 1 abstention; q103 and q016 provider errors |
| Failed-judgment Jev retry | `pass_c7b1d0fc-3dc4-403b-9cba-aa87bb7bf08d` |  50 saved answers | No target calls |         0 errors / 48 usable | Complete    | q103 resolved; q016 and q092 abstain        |

The campaign aspiration remains one clean 50-question run with zero target failures and zero Jev provider errors.

That strict first-pass goal remains unmet: batch 8 completed all 50 target attempts, but its original Jev pass recorded two provider errors and one below-threshold abstention.

The linked retry completed `q108` and produced one usable answer classification, but it does not change the original run's 49-of-50 result or its three abstentions.

Batches 4 and 5 produced 58 distinct questions with usable Jev verdicts, and all 50 questions selected for final verification have usable prior verdict provenance.

This establishes 50 distinct previously judged questions, not a clean first-pass final run.

After the batch 9 failed-judgment retry, the selected derived pass contains responses for all 50 saved answers, with 48 usable judgments, two below-threshold abstentions, and zero current provider errors.

The two abstentions are `q092` at 0.46 and `q016` at 0.43 against the unchanged 0.6 threshold.

The original Jev pass and its two provider errors remain preserved, so the campaign achieved 50 processed questions after recovery, not a clean first pass or 50 definitive verdicts.

## Evidence to record

For each batch, record the run ID, exact question count, completed and failed target attempts, failure categories, Jev completion and failure counts, and independent Luna review.

Preserve target correctness separately from execution reliability.

Do not launch a follow-up batch until the prior batch has a Luna review and the parent accounts for it against the shared ceiling.

## Launch record

The frozen run ID is `run_23321bfb-9817-41aa-aa35-2d6797ab7eb6`.

The launch used [`baseline.json`](../.aeh/luna-jev-reliability/baseline.json) and idempotency key `luna-jev-reliability-baseline-20261007`.

The 50 distinct question IDs are `q001`, `q003`, `q005`, `q007`, `q009`, `q011`, `q013`, `q017`, `q018`, `q019`, `q020`, `q021`, `q024`, `q026`, `q027`, `q029`, `q031`, `q034`, `q035`, `q039`, `q041`, `q044`, `q047`, `q049`, `q054`, `q056`, `q057`, `q060`, `q063`, `q066`, `q067`, `q069`, `q074`, `q075`, `q078`, `q080`, `q081`, `q085`, `q087`, `q089`, `q090`, `q091`, `q094`, `q096`, `q098`, `q099`, `q101`, `q104`, `q108`, and `q109`.

The run completed 10/50 target questions, with zero target execution failures and four Jev errors.

The recorded token-limit errors report that the complete request exceeded the provider limit and that evidence was not truncated.

The run uses the backend version present at launch.

The parent requested a graceful pause after the repeated Jev token-limit defect was confirmed.

Pause was requested at 9/50, and the active `q019` target and Jev work completed before cancellation.

The 40 remaining questions were unstarted and canceled intentionally after the run entered `paused` with no active attempt.

They are not counted as execution failures.

## Baseline review

All 10 completed target attempts reached `submit_answer`, and none had a target execution failure or Tableau tool transport/protocol error.

Question `q019` had three `query-datasource` calls that returned failure status with in-band field/filter validation text.

Their error fields were null, so these were query-level failures rather than harness transport/protocol errors.

The target therefore had zero harness failures in the 10 executed questions.

The six Jev classifications completed for `q001`, `q003`, `q005`, `q009`, `q013`, and `q019`.

Jev marked `q009` and `q019` as requiring review.

For `q009`, Jev confidence was 0.61 for answer correctness, 0.40 for evidence support, and 0.70 for reference quality.

For `q019`, Jev confidence was 0.48 for answer correctness, 0.53 for evidence support, and 0.33 for reference quality.

Jev returned token-limit errors for `q007`, `q011`, `q017`, and `q018`.

Those four traces include repeated datasource discovery responses up to 71,226 bytes each.

The metadata response was 24,706 bytes, and the largest completed answer contained 347 rows and 12,390 bytes.

The Jev errors report that the complete request exceeded TypeSafe's token limit, and the assessment records contain no partial classification.

Target correctness remained diagnostic, but the deterministic outcomes show four correct answers and six incorrect answers.

The incorrect answers include empty arrays on `q011` and `q017`, which the answer tool accepted as answers.

The 347-row answer on `q018` and 30-row answer on `q019` were also submitted successfully, although deterministic comparison marked both incorrect.

The in-band metadata error on `q011` preceded its empty answer.

Question `q017` returned an empty answer without a query result.

Both are clear answer failures against the supplied references.

The `q009` answer was a plausible cutoff-tie case because at least 18 customers tied at seven purchases while the reference contains only ten.

Its disagreement with the reference does not establish that the submitted values were wrong.

The audit found no engine bug; the reference and cutoff-tie acceptance policy need review before drawing an accuracy conclusion.

The `q018` response returned the same 347 titles as the reference but differed at 106 positions despite the requested ascending sort.

The ordering discrepancy does not independently establish that either collation is incorrect.

The audit found no engine bug; the reference ordering and collation policy need review before drawing an accuracy conclusion.

For the saved-answer audit, `q001` matched the reference values and differed only in the order of equal-count Brazil and France rows.

`q007` returned the same five names as the reference.

`q019` omitted two titles from the 32-row reference, and both titles appeared in the saved 347-title Tableau response.

These answer comparisons use saved run evidence and do not independently validate source data or reference quality.

The complete machine-readable review is [`baseline-review.json`](../.aeh/luna-jev-reliability/baseline-review.json).

## Saved-answer Jev rejudge

Batch 2 of 20 uses [`rejudge-10.json`](../.aeh/luna-jev-reliability/rejudge-10.json) to reassess the 10 sealed answers with the same active Jev profile.

It does not invoke the target or an LLM judge.

The first new Jev request for `q001` is 7,810 bytes and stores `observationLevel: answer-only`, `trace.format: unavailable`, and `trace.entries: null`.

The request has no transcript or tool result fields.

All 10 rejudges completed, with zero transport or token-limit errors.

The saved requests all use answer-only evidence with unavailable traces and no transcript or tool result fields.

Serialized request sizes fell from 35,747-413,905 bytes in the baseline to 7,522-31,696 bytes in the rejudge.

Jev input usage fell to 2,455-13,310 tokens per request.

Every new classification sets `reviewRequired: true` because the reference quality dimension is `unknown` without internal trace evidence.

The records show zero transport failures, but they do not produce usable verdicts for the campaign.

The pass contains 50 fixed slots with 0 judged and 50 unjudged.

The 10 available classifications require review, and 40 slots have no saved answer.

The complete machine-readable comparison is [`rejudge-review.json`](../.aeh/luna-jev-reliability/rejudge-review.json).

## Answer-only saved-answer Jev rejudge

Batch 3 of 20 uses [`rejudge-10-answer-only.json`](../.aeh/luna-jev-reliability/rejudge-10-answer-only.json) with the published answer-only Jev profile `jevprofile_26dc51ba-7acf-4ea0-9593-9bda372c9cfa`.

The new profile keeps confidence threshold 0.6 and all three check dimensions.

The original active Jev profile remains unchanged.

The profile treats the supplied reference as the comparison basis for answer correctness and evaluates source evidence support and reference quality separately.

The saved-answer batch completed without Jev transport or token-limit errors.

Eight of 10 classifications produced usable verdicts.

`q003`, `q007`, and `q013` were classified acceptable with answer confidence 0.97, 0.97, and 0.89.

`q009`, `q011`, `q017`, `q018`, and `q019` were classified incorrect with answer confidence 0.94, 1.00, 1.00, 0.97, and 0.91.

`q001` and `q005` returned acceptable choices with answer confidence 0.33 and 0.52, below the 0.6 threshold.

Both remain unjudged in the pass because their answer confidence did not meet the frozen threshold.

The accepted answers had insufficient source evidence, while the reference dimension remained separate.

The full-50 target request is [`full50-answer-only.json`](../.aeh/luna-jev-reliability/full50-answer-only.json).

It preserves all 50 distinct IDs, uses the verified datasource LUID in the system prompt, and explicitly instructs submission of `[]` when no rows match.

The run launched as batch 4 of 20 at 2026-10-07 21:30 UTC with test 3's answer-only Jev profile.

The run completed all 50 target attempts, with zero target execution failures and zero missing `submit_answer` results.

Five submitted answers were empty arrays, which the submission schema allows.

There were no Tableau transport/protocol errors, although 35 tool calls returned in-band failure status and answer text.

Jev completed 46 classifications, with 37 usable verdicts, nine below-threshold abstentions, and four provider errors.

The Jev errors were token-limit errors on `q085`, `q096`, and `q098`, plus an invalid provider response on `q104`.

The nine below-threshold answer classifications were `q001` at 0.28, `q005` at 0.48, `q027` at 0.41, `q034` at 0.48, `q047` at 0.51, `q066` at 0.37, `q075` at 0.38, `q078` at 0.35, and `q091` at 0.51.

The full result audit is [`full50-review.json`](../.aeh/luna-jev-reliability/full50-review.json), and the concise run snapshot is [`full50-current.json`](../.aeh/luna-jev-reliability/full50-current.json).

The pass has 20 acceptable and 17 incorrect classifications among usable verdicts.

Answer correctness remains diagnostic and does not change the execution counts.

This batch did not meet the zero-Jev-error goal.

## Supplemental 25-question run

The supplemental request is [`supplemental25-answer-only.json`](../.aeh/luna-jev-reliability/supplemental25-answer-only.json).

It contains 25 distinct IDs outside the first 50 and launched as batch 5 of 20 at 2026-10-07 21:53 UTC.

All 25 target attempts completed and reached `submit_answer`, with zero target failures and zero missing submissions.

Two answers were empty arrays, and four tool calls returned in-band failure status without transport/protocol errors.

Jev completed all 25 classifications, with 21 usable verdicts, four below-threshold abstentions, and zero provider errors.

The four below-threshold answer classifications were `q076` at 0.23, `q048` at 0.59, `q077` at 0.52, and `q111` at 0.28.

The usable verdicts include 10 acceptable and 11 incorrect answers.

The independent audit is [`supplemental25-review.json`](../.aeh/luna-jev-reliability/supplemental25-review.json).

The usable verdicts from batches 4 and 5 cover 58 distinct question IDs.

The selected final 50 uses 36 usable results from batch 4 and 14 from batch 5.

It includes both acceptable and incorrect prior verdicts, including `q019` and `q109` because both met the confidence threshold.

It excludes `q094` because its 33,443-byte expected result is close to the observed Jev capacity failures.

It also excludes the three token-limit results and the `q104` invalid provider response.

The 50 IDs and per-question run, answer, and confidence provenance are in [`final50-selection.json`](../.aeh/luna-jev-reliability/final50-selection.json).

The final verification request is [`final50-answer-only.json`](../.aeh/luna-jev-reliability/final50-answer-only.json).

It launched as batch 6 of 20 at 2026-10-07 22:04 UTC as `run_b0b7e3a0-d927-489a-97a3-bba4c64df74e`.

The run completed 49 of 50 target attempts.

The only target failure was `q108`, which reached the configured tool-call limit before submitting an answer.

The other 49 questions submitted answers, with zero Jev provider errors.

Jev produced 46 usable answer classifications: 28 acceptable and 18 incorrect.

Three completed answer classifications remained below the frozen 0.6 confidence threshold.

Those abstentions were `q054` at 0.53, `q092` at 0.34, and `q016` at 0.30.

The failed `q108` result and the three abstentions remain visible in the original run.

The result summary is [`final50-review.json`](../.aeh/luna-jev-reliability/final50-review.json), the per-question audit is [`final50-review-detail.json`](../.aeh/luna-jev-reliability/final50-review-detail.json), and the saved run evidence is [`final50-completed.json`](../.aeh/luna-jev-reliability/final50-completed.json).

The final 50 contains 50 distinct questions selected from 58 distinct questions with usable prior verdicts in batches 4 and 5.

It does not claim that the final verification run itself produced 50 usable verdicts.

The saved probability audit found two of 147 dimension responses whose rounded probabilities total 0.99.

Both were reference dimensions, for `q035` and `q080`, and both pass the deployed bounded tolerance.

See [`final50-probability-rounding-audit.json`](../.aeh/luna-jev-reliability/final50-probability-rounding-audit.json).

The launch settings are saved as blueprint `blueprint_efd2d562-ce08-41c1-bb97-f2752fe02e8a`, named `Luna low + Jev - reliability 50`.

Batch 7 of 20 retries only the failed `q108` result, using the original frozen configuration.

The retry run is `run_7e8dec17-dbea-4309-aec0-4cae16207420`.

It completed and submitted `[]`.

Jev classified the answer acceptable with confidence 0.94, above the 0.6 answer threshold.

The retry preserves the original run's failed `q108` result and does not rewrite its 49-of-50 completion count.

The retry evidence is [`q108-retry-current.json`](../.aeh/luna-jev-reliability/q108-retry-current.json), [`q108-retry-attempt.json`](../.aeh/luna-jev-reliability/q108-retry-attempt.json), and [`q108-retry-review.json`](../.aeh/luna-jev-reliability/q108-retry-review.json).

## Final verification rerun v2

Batch 8 of 20 launched at 2026-10-07 22:35 UTC as `run_e32f8cd9-46d6-430e-aee3-ff7d7ab4b5b7`.

The request is [`final50-v2-answer-only.json`](../.aeh/luna-jev-reliability/final50-v2-answer-only.json), and the selection provenance is [`final50-v2-selection.json`](../.aeh/luna-jev-reliability/final50-v2-selection.json).

It replaces only `q108` with `q028`, which completed with one submission, zero transport errors, zero failed tool calls, and an above-threshold Jev classification in batch 5.

The replacement was selected by reliability eligibility and the smallest expected output among unused eligible supplemental questions, not by answer correctness.

The original `q108` failure remains recorded alongside its successful linked retry.

The target keeps the same model, low reasoning effort, system prompt, tools, Jev profile, concurrency, timeout, and output cap, with `maxTurns` increased from 40 to 80.

The run completed all 50 target attempts with zero target failures.

The original Jev pass had two provider failures, for `q103` and `q016`, and one below-threshold abstention, `q092` at 0.46.

The run audit is [`final50-v2-review.json`](../.aeh/luna-jev-reliability/final50-v2-review.json), and the per-question audit is [`final50-v2-review-detail.json`](../.aeh/luna-jev-reliability/final50-v2-review-detail.json).

## Recovered Jev assessment

Batch 9 of 20 retries only the two provider-error judgments in the original Jev pass.

The retry request is [`final50-v2-jev-retry.json`](../.aeh/luna-jev-reliability/final50-v2-jev-retry.json), and the derived pass is `pass_c7b1d0fc-3dc4-403b-9cba-aa87bb7bf08d`, named `Luna low + Jev reliability 50 v2 - retry provider failures`.

It carries forward the other saved judgments and does not run target agents or modify earlier answers.

The derived pass has responses for 50 saved answers, 48 usable judgments, zero current provider errors, and two below-threshold abstentions.

`q092` retains its 0.46 confidence abstention, and the retried `q016` answer is incorrect at 0.43 confidence.

The retry recovered `q103` as incorrect at 1.00 confidence.

The original pass retains both provider errors, and the abstentions remain unjudged at the unchanged 0.6 threshold.

The saved pass audit is [`final50-v2-derived-pass-review.json`](../.aeh/luna-jev-reliability/final50-v2-derived-pass-review.json), with per-question details in [`final50-v2-derived-pass-review-detail.json`](../.aeh/luna-jev-reliability/final50-v2-derived-pass-review-detail.json).

The current run record selects the recovered pass in `runs.get` and `runs.list`.

An earlier server restart reset the run's selected pass to the deterministic pass, and the recovered pass was selected again afterward.

The reason for that reset is unknown, so use the explicit `score` parameter in the run review URL to open this pass regardless of the selected-pass state.

The current selection verification is [`final50-v2-selected-pass-verified.json`](../.aeh/luna-jev-reliability/final50-v2-selected-pass-verified.json).

The run review URL includes the explicit `score` parameter so it opens the recovered pass directly.

The v2 blueprint is `blueprint_a3354ee2-0fbc-4135-aa2f-6ce9120b6c42`, named `Luna low + Jev reliability 50 v2 - q028 replacement - 80 turns`.

The verified launch configuration is stored in the blueprint, and the exact question selection remains in [`final50-v2-selection.json`](../.aeh/luna-jev-reliability/final50-v2-selection.json).

Open the final run directly on the recovered assessment at [the run review](http://127.0.0.1:4393/observe/run_e32f8cd9-46d6-430e-aee3-ff7d7ab4b5b7?score=pass_c7b1d0fc-3dc4-403b-9cba-aa87bb7bf08d).

Open the saved launch settings at [the v2 blueprint](http://127.0.0.1:4393/run?blueprint=blueprint_a3354ee2-0fbc-4135-aa2f-6ce9120b6c42).

The bank's active Jev profile now points to `jevprofile_26dc51ba-7acf-4ea0-9593-9bda372c9cfa`, named `Jev answer-only correctness comparison`.

Activation changed the bank's active profile pointer only; prior revision `jevprofile_3a3fa3b7-f89a-44e4-b277-4e6dae280035` and historical run configurations remain preserved.

## Validation status

After the formatting blockers were resolved, the parent reports that final validation passed 422 tests with 12 skipped and deployed build `2026-10-07T23:10:50.875Z`.

The deployed build includes the network-diagnostic change that passed 28 focused tests, typecheck, and lint.

Batch 8 and its batch 9 Jev retry ran before the network-diagnostic deployment, so their original provider failures remain recorded without the later diagnostic instrumentation.

The campaign operator did not modify the unrelated formatting files.

No provider-backed batches followed batch 9.

## Changes active in the final build

| Change                                 | Effect                                                                                                         | Evidence                                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Answer-only trace projection           | Sends the answer and reference without the full target trace.                                                  | Batch 2 requests fell to 7,522-31,696 bytes and had zero token-limit errors.                |
| Per-answer threshold eligibility       | Scores answer correctness using its own threshold while preserving separate evidence and reference dimensions. | Batch 3 produced eight usable verdicts and kept two below-threshold results as abstentions. |
| Bounded probability rounding tolerance | Accepts provider probabilities whose rounded values sum to 0.99 while still validating the response.           | Deployed in the final build; two of 147 live dimension responses had a 0.99 sum and passed. |
| Large expected outputs                 | Retains capacity failures without truncating answers or changing references.                                   | Batch 4 recorded Jev token-limit errors for q085, q096, and q098.                           |
| Reference policy                       | Keeps cutoff ties and text collation as reference-policy questions.                                            | q009 and q018 review found no engine bug and recommends reference-policy review.            |
