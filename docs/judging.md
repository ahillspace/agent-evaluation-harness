# Independent judges

Deterministic grading remains the default assessment.
Each Run supports named deterministic, LLM, Jev, and human assessment passes over its saved answers.
Human review derives a new pass and preserves every untouched judgment.
Enabling a judge does not replace the deterministic score or change the reference answer.

## Configure Jev

Add a TypeSafe connection in Settings and save its API key in the encrypted local credential store.
Select Jev in Run setup and choose a published judging profile for the question bank.
Each profile defines editable instructions and criteria for three decisions:

| Decision           | Outcomes                                                    |
| ------------------ | ----------------------------------------------------------- |
| Answer correctness | Acceptable, incorrect, or insufficient evidence.            |
| Evidence support   | Supported, contradicted, or insufficient evidence.          |
| Reference quality  | Consistent, suspected reference issue, or cannot determine. |

A run freezes its selected profile and public connection configuration.
Publishing a different profile affects future selections and does not rewrite saved runs.
Pin a versioned model to compare results under the same model version.
The initial integration uses `jev-1.13.0`.

## Understand the evidence

Jev receives the original question, reference answer, acceptance criteria, submitted answer, and relevant agent configuration.
The frozen profile's evidence requirement determines whether the request also includes the attempt trace.
An answer-only profile omits the internal-activity trace from the request, even when the sealed attempt contains it.
The full sealed evidence and its hashes remain available in the saved assessment.
The request preserves every profile instruction and criterion.
Its instructions tell Jev to return insufficient evidence when a criterion requires activity absent from the request.
An internal-activity profile receives the complete recorded trace.
The evidence builder reads canonical stored records rather than abbreviated observation previews.
Prior judge verdicts and deterministic pass or fail labels are excluded from the decision input.
Credentials are excluded from the payload and its saved provenance.

Complete recorded evidence includes messages and tool activity exposed by the target provider.
It cannot include hidden reasoning or output that the provider never returned.
Earlier interrupted attempts are separate evidence and do not become part of a successful retry's trace.

The published TypeSafe limit is 32,000 tokens for the state plus the longest question and 64,000 tokens for the whole request.
Oversized evidence produces a capacity error instead of a truncated request.
Selecting another judge preserves the original evidence.
The adapter also applies a separate 2 MiB request limit to bound local memory use.
This byte limit does not estimate the provider's token count.

### Recover from oversized traces

In **Question banks > Jev criteria > Oversized trace fallback**, enable **Allow answer-only fallback** before publishing a profile.
The option is off by default.
When a trace request exceeds a size limit, Jev receives one additional request with the complete question, expected answer, and submitted answer.
The additional request omits agent activity and uses the profile's separate fallback instructions and answer criteria.
Question-specific overrides apply to the primary request, not these fallback criteria.
Review the fallback criteria before enabling the option, especially when your primary checks require specific tool actions.

The result displays **Answer-only fallback**.
Evidence support and reference consistency display **Not assessed**, without invented probabilities.
A confident answer verdict contributes to the saved score, but the assessment still needs review and cannot automatically promote a research candidate.
The original size error, original request, fallback criteria, and complete sealed evidence remain available through **Inspect recorded request and provenance**.
Usage includes both requests when reported; missing usage remains unknown.

Fallback does not run for authentication failures, network errors, cancellation, or requests that already omit traces.
It uses the remaining time from the original assessment deadline.
If the complete answer and reference still exceed the limit, the assessment remains an error.
No answer or trace is silently truncated.

## Interpret results

Jev returns predefined labels, probabilities, and confidence.
It does not generate a written explanation.
The interface displays the classifications and the instructions that produced them without inventing explanatory prose.
A configured confidence threshold can mark a result as needing review.
Confidence is a summary of the probability distribution, not a guarantee of correctness.
An assessment pass records a correct or incorrect answer verdict when the answer choice is decisive and meets the frozen answer confidence threshold.
Low-confidence and insufficient-evidence answer decisions remain unjudged.
The overall review flag remains linked to the Jev record and does not erase a confident answer verdict when another check needs review.
Research candidate promotion applies the stricter rule that Jev assessments with any review flag are ineligible.

A suspected reference issue flags the question for review.
It does not automatically pass the target or edit the answer bank.
Provider errors, capacity errors, and uncertain judgments remain distinct from incorrect answers.

## Judge saved answers

Open a saved Run and add a named assessment using answer rules, an LLM judge, or Jev.
Select the evaluator or judging configuration and save the assessment.
The engine freezes its configuration and references, assesses the sealed answers, and saves the pass automatically.
New passes preserve earlier judgments and never rerun the target agent.
The saved score selector reopens any pass and remembers your selection for that Run.

Closing a dialog or browser does not cancel work already admitted by the engine.
The engine records progress and saves each judgment before continuing.
If the engine stops, restart marks the unfinished pass interrupted without silently repeating provider calls.
Retry creates a new pass, carries completed judgments forward, and retries only failed or unfinished judgments with saved answers.
Failed target executions need an execution retry, and a completed judge abstention remains an abstention.

Human review starts from any saved pass and saves a named derived pass.
Untouched judgments carry forward, and edits retain the reviewer, note, previous judgment, and review time.
Questions without a sealed answer accept notes or explicit exclusions but cannot receive a correctness verdict.

Accuracy is correct answers divided by completed judgments with a correctness verdict.
Pending questions, execution failures, and judge errors do not count as incorrect judgments.
The interface shows answered, judged, unjudged, failed, and excluded coverage separately.
Research selection separately uses correct answers divided by fixed eligible slots and requires coverage that matches or exceeds the baseline.
This research objective prevents failed answers and judge errors from improving candidate selection by shrinking its denominator.
Comparisons use the selected passes and disclose differences in their effective evaluation bases.

A deliberate pass read or export contains frozen references and available request, response, error, usage, and evidence-hash records.
Jev records include the provider request and response; LLM records include the semantic request passed to its runtime and the returned verdict.
Earlier records can lack request data that was not recorded at execution time.
Large evidence payloads stay out of observation and Results summaries.

## Read progress and usage

Runs open on **Questions**, with **Summary**, optional **Research**, and **Configuration** available beside it.
The shared score strip shows all saved scores and their judgment coverage.
Usage keeps target, researcher, and judge totals separate.
Reported subtotals remain visible while other calls are pending or have unreported usage.
**Input** shows uncached tokens, **Output** shows generated tokens, and **Cache** shows reused input tokens.
Stored inclusive input remains available in evidence and budget accounting.
Older target evidence can recover its cache breakdown from matching provider usage records.
When the breakdown is unavailable, uncached input remains unreported.

## Architecture

The application layer builds evidence, freezes profiles, applies result policy, and owns named assessment creation and derivation.
The runtime classifier port resolves credentials and performs the bounded HTTP request.
The TypeSafe adapter translates the shared judging input into the provider's request format and validates its response.
The browser and CLI use the same application operations.
The target harness has no access to the judge's reference answer or credentials.

## Verification priorities

Use recorded fixtures to check rounding, tied rankings, incorrect reference answers, missing evidence, contradictory tool results, and instructions embedded in traces.
Exercise malformed responses, authentication errors, rate limits, oversized traces, timeout, and cancellation.
Verify that reopening and exporting saved passes makes no provider call and that reassessment makes no target call.
Include judge usage in research spending checks.
Never use Astra models for test or validation runs.

## Provider references

- [TypeSafe HTTP API](https://docs.typesafe.ai/api)
- [Model versions and limits](https://docs.typesafe.ai/models)
- [Confidence](https://docs.typesafe.ai/confidence)
- [Known model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
