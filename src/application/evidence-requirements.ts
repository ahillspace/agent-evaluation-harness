import {
  judgeSchema,
  type EvaluatorSettings,
  type FrozenJevJudge,
  type JudgeConfig,
} from "../contracts.js";
import { AppError } from "../domain/errors.js";
import {
  evaluatorEvidenceRequirement,
  evidenceSupports,
} from "../domain/evidence-requirements.js";

export function validateTargetEvidence(input: {
  observation: "answer-only" | "internal-activity";
  questionIds: string[];
  evaluator: EvaluatorSettings;
  judge: JudgeConfig;
  jevJudge?: FrozenJevJudge;
}): void {
  for (const questionId of input.questionIds) {
    const effective = {
      ...input.evaluator,
      ...input.evaluator.questionOverrides[questionId],
    };
    if (
      !evidenceSupports(
        input.observation,
        evaluatorEvidenceRequirement(effective),
      )
    )
      throw new AppError(
        "unsupported_evidence",
        `Question ${questionId} requires unavailable or unspecified evidence. Publish an evaluator revision declaring answer evidence before using an external agent.`,
      );
  }
  if (input.judge.enabled) {
    const requirement =
      input.judge.evidenceRequirement ??
      (input.judge.instructions === judgeSchema.parse({}).instructions
        ? "answer"
        : "unspecified");
    if (!evidenceSupports(input.observation, requirement))
      throw new AppError(
        "unsupported_evidence",
        "The LLM judge must declare answer evidence for an external agent. Update its requirements or disable judging.",
      );
  }
  if (
    input.jevJudge &&
    !evidenceSupports(
      input.observation,
      input.jevJudge.profile.settings.evidenceRequirement ?? "unspecified",
    )
  )
    throw new AppError(
      "unsupported_evidence",
      "The Jev profile must declare answer evidence for an external agent. Publish a compatible profile or disable Jev.",
    );
}
