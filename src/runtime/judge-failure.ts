import type { JudgeInvocation } from "../contracts.js";

export class JudgeFailure extends Error {
  readonly code = "judge_failed";
  constructor(
    message: string,
    readonly invocation: JudgeInvocation,
  ) {
    super(message);
    this.name = "JudgeFailure";
  }
}
