import { AppError } from "./errors.js";

export const RESEARCH_HISTORY_UNAVAILABLE =
  "Researcher admission history is unavailable. Start a new research session explicitly.";
export type ResearchTurnAccounting =
  | { status: "known"; interrupted: number; nextInvocation: number }
  | { status: "unavailable"; interrupted: number | undefined };

export function researchTurnAccounting(input: {
  admitted?: number;
  completed: number;
  pending: boolean;
  recordedInterrupted?: number;
  history: boolean;
}): ResearchTurnAccounting {
  const recorded = input.recordedInterrupted ?? 0;
  if (input.admitted === undefined)
    return input.completed === 0 &&
      !input.pending &&
      recorded === 0 &&
      !input.history
      ? { status: "known", interrupted: 0, nextInvocation: 1 }
      : {
          status: "unavailable",
          interrupted: recorded > 0 ? recorded : undefined,
        };
  if (
    !Number.isSafeInteger(input.admitted) ||
    input.admitted < input.completed + Number(input.pending)
  )
    throw new AppError(
      "invalid_state",
      "Saved researcher admission history is inconsistent.",
    );
  return {
    status: "known",
    interrupted: input.admitted - input.completed - Number(input.pending),
    nextInvocation: input.admitted + 1,
  };
}
