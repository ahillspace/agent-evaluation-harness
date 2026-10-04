# Real evaluation campaign

This campaign evaluates the same 20 source-backed analytics questions with Luna through Codex and SpaceBunny through OpenCode.
All six runs are complete as of 2026-10-04 02:11 UTC.
The campaign records 115 completed answers and five failed executions.
No Astra provider calls occur in these runs.

## Scope and evidence

Questions cover rankings, ties, counts, currency, dates, joins, null groups, and empty results.
Each model answers each question once per run.
The six runs contain 120 evaluation slots across 20 unique questions, not 120 distinct questions.
The original source references remain unchanged, including known defective references.
The app preserves frozen run configurations, target evidence, original assessments, and later score sets.

The source audit compares recorded answers and tool traces with the original SQLite data.
It independently checks ambiguous customer ties, global state counts, album joins, hire-date ties, and empty playlists.
This is an assistant audit, not a human review or an app-generated accuracy score.
No assistant conclusions are written into records labeled **Human review**.
Detailed evidence hashes, result IDs, and question-level classifications remain in local QA artifacts under `.aeh/qa-campaign`.

## Completed runs

| Cohort                                                   | Model      | Completed answers | Failed executions | Deterministic passes |
| -------------------------------------------------------- | ---------- | ----------------: | ----------------: | -------------------: |
| Original bank, original evaluator                        | Luna       |                20 |                 0 |                 6/20 |
| Original bank, original evaluator                        | SpaceBunny |                19 |                 1 |                 4/19 |
| Public-format bank revision two, reviewed evaluator      | Luna       |                20 |                 0 |                14/20 |
| Public-format bank revision two, reviewed evaluator      | SpaceBunny |                17 |                 3 |                13/17 |
| Nullable public format revision three, corrected runtime | Luna       |                20 |                 0 |                13/20 |
| Nullable public format revision three, corrected runtime | SpaceBunny |                19 |                 1 |                13/19 |

Failed executions stay outside completed-answer accuracy.
An overall Run status of completed does not imply every question succeeds.
The baseline Luna run also uses an independent Luna judge, which passes 14 answers and rejects six.
SpaceBunny has no independent judge in the baseline, and both later cohorts disable it.
These runs do not invoke Jev; live TypeSafe/Jev behavior remains unverified by this campaign.

## Immutable rescoring

Reviewed evaluator revision two adds observed semantic column aliases and an explicit cent-rounding policy for average invoice values.
It also identifies the average-value ordering key so equal averages can appear in either order.
It preserves full row coverage, duplicates, private reference values, and unsupported wrapper rejection.
It does not repair defective references or globally disable ordering.

Rescoring the original saved answers increases Luna from 6 to 12 passes and SpaceBunny from 4 to 9.
This operation does not rerun the target or overwrite the original scores.
Those counts differ from the new revision-two target runs, which produce new answers under a public format.

## Source correctness

| Cohort               | Luna                                                                           | SpaceBunny                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline             | 18 clearly correct answers; two target errors                                  | 18 clearly correct answers; one malformed submission; one execution failure                                                           |
| Revision two         | 17 clearly correct answers; two target errors; one changed null representation | 15 clearly correct answers; one omitted null group; one wrong submitted value; three execution failures                               |
| Final revision three | 17 clearly correct answers; three target errors                                | 16 clearly correct answers; one null-count submission; one null placeholder; one wrong empty-string submission; one execution failure |

Correct source information can still fail deterministic grading when the answer representation differs from the reference.
Conversely, correct reasoning in prose does not repair an incorrect submitted value.
Revision-two SpaceBunny q099 explains that no Movies tracks exist but submits an empty string instead of an empty list.
That outcome is a submission error, not a clean evaluator false negative.

## Confirmed reference defects

- q009 chooses an arbitrary ten customers from 58 customers tied at seven orders, without a public secondary tie rule.
- q028 expects 11 USA state groups although the question asks globally, where 26 groups include a null group of 202 invoices.
- q031 requires a constant state column absent from the original question; revision two makes that column public.
- q065 asks for ten employees although only eight exist, and its reference lacks an explicit hire-date tie policy.
- q089 joins the wrong key and returns 130 Jazz tracks; the correct album join returns one track.

These defects remain visible rather than being repaired through permissive grading.
The independent Luna judge falsely rejects q009, q028, q031, and q065 by overtrusting reference details or the requested count.
Its q019 and q089 rejections identify actual target errors.

## App and runtime findings

Public table formats resolve many hidden-column and row-shape failures without exposing reference values or row counts.
However, the initial derivation copies restrictive nullability from the reference.
On q028, Luna converts null to a string, and SpaceBunny explicitly drops the null group to satisfy that inferred requirement.
The revised publication policy defaults derived public columns to nullable while retaining explicit authored restrictions and deterministic reference rules.
Existing bank revisions and runs remain frozen.

For q019, an advertised album caption fails in direct upstream queries, while a calculated-field expression resolves it.
SpaceBunny recovers and returns 32 correct albums in all three cohorts.
Luna substitutes unrelated fields or returns empty, producing a real recovery error.

Revision-two Luna q089 returns the 26 tracks in Heavy Metal Classic instead of the requested album.
An independent source query confirms that mistaken playlist selection.
The defective gold reference does not excuse this target error.

Revision-two SpaceBunny q003 times out after an accepted partial submission and repeated invalid revision attempts.
Runtime changes address connection-gate waiting and truthful responses after a submission is sealed.
SpaceBunny q051 reaches OpenCode's repeated-call permission guard, and q053 ends without a valid submission.
The final pair completes q003 successfully, while SpaceBunny q009 later times out after a successful query and no further provider output.
Final Luna q047 incorrectly adds Un-Led-Ed by Dread Zeppelin to the 14 matching albums, as independently checked in SQLite.

## Token accounting

| Completed run                              | Inclusive known tokens |
| ------------------------------------------ | ---------------------: |
| Baseline Luna, including independent judge |              2,189,073 |
| Baseline SpaceBunny                        |              2,985,706 |
| Revision-two Luna                          |              2,552,957 |
| Revision-two SpaceBunny                    |              3,314,178 |
| Final Luna                                 |              2,288,659 |
| Final SpaceBunny                           |              2,787,426 |
| Total                                      |             16,117,999 |

Recorded evaluation-run usage equals 32.24% of the 50-million-token ceiling.
This table excludes engineering-agent work and diagnostic probes, so it does not establish the total remaining allowance.
Five failed invocations retain unknown remainders.
Their recorded partial totals are 49,592, 710,582, 31,410, 91,402, and 70,490 tokens, already included above.

The initial OpenCode aggregate omits cached input and reasoning tokens.
Corrected accounting restores those disjoint components once, validates provider totals, and deduplicates step IDs.
The audit never adds a final aggregate to its component events.
Missing or inconsistent usage remains unknown; missing cost is not zero cost.
Codex resumed research retains its existing conversation-scoped cumulative accounting.

## Comparison limits and final validation

One repetition per model does not establish reliability or a general model ranking.
Bank revision, public requirements, evaluator revision, and Luna judge configuration change between cohorts.
The observed improvement therefore does not isolate a single causal change.
Known source defects mean deterministic accuracy remains distinct from source correctness.

The final pair uses bank revision three and the corrected runtime.
Luna submits the actual q028 null group successfully; the unchanged defective private reference still rejects grading.
SpaceBunny retains a placeholder despite the nullable format, so its submission is not fully source-correct.
SpaceBunny q013 submits null counts despite correct query evidence; deterministic grading correctly rejects this submission.
Waiting events are observed, both q003 answers complete, and all 19 completed SpaceBunny attempts match native inclusive usage exactly.
No natural repeated call after a sealed answer occurs in the final pair; that branch has regression coverage rather than live confirmation.
All reference values remain unchanged.
The final read-only capture is `.aeh/qa-campaign/reports/2026-10-04T02-11-17-929Z`.
The consolidated `final-source-audit.json` contains all 120 question-level conclusions and evidence references.
