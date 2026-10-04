# Independent judges

Deterministic grading remains the default assessment.
Optional LLM and Jev judges record independent assessments of the same saved answer.
Human reviews remain separate from both.
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

Jev receives the original question, reference answer, acceptance criteria, submitted answer, relevant agent configuration, and the complete recorded trace for that attempt.
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

## Interpret results

Jev returns predefined labels, probabilities, and confidence.
It does not generate a written explanation.
The interface displays the classifications and the instructions that produced them without inventing explanatory prose.
A configured confidence threshold can mark a result as needing review.
Confidence is a summary of the probability distribution, not a guarantee of correctness.

A suspected reference issue flags the question for review.
It does not automatically pass the target or edit the answer bank.
Provider errors, capacity errors, and uncertain judgments remain distinct from incorrect answers.

## Judge saved answers

Select saved evidence and a judging configuration, then preview the assessment.
Preview calls the judge and saves its result with its exact request and configuration.
Publishing accepts that saved preview without another provider call.
New assessments preserve all earlier results and never rerun the target agent.
Reopening saved-answer judging restores completed unpublished previews for review and publication.
For multiple selections, the interface requests one assessment at a time and reports progress.
Closing the browser stops further selections from being submitted; assessments already recorded remain saved.

Each assessment records the source attempt, evidence hash, profile, model, provider response, and reported usage.
These records make disagreements and changes in judging criteria inspectable.
When cost is calculated from reported token usage and a published price, the assessment also preserves that pricing basis.

## Architecture

The application layer builds evidence, freezes profiles, applies result policy, and owns assessment publication.
The runtime classifier port resolves credentials and performs the bounded HTTP request.
The TypeSafe adapter translates the shared judging input into the provider's request format and validates its response.
The browser and CLI use the same application operations.
The target harness has no access to the judge's reference answer or credentials.

## Verification priorities

Use recorded fixtures to check rounding, tied rankings, incorrect reference answers, missing evidence, contradictory tool results, and instructions embedded in traces.
Exercise malformed responses, authentication errors, rate limits, oversized traces, timeout, and cancellation.
Verify that publication makes no second call and that rejudging makes no target call.
Include judge usage in research spending checks.
Never use Astra models for test or validation runs.

## Provider references

- [TypeSafe HTTP API](https://docs.typesafe.ai/api)
- [Model versions and limits](https://docs.typesafe.ai/models)
- [Confidence](https://docs.typesafe.ai/confidence)
- [Known model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
