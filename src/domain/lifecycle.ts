import type { Control, RunIntent, RunStatus } from "../contracts.js";
import { AppError } from "./errors.js";

export function allowedActions(status: RunStatus): Control[] {
  switch (status) {
    case "queued":
    case "running":
      return ["pause", "halt", "cancel"];
    case "pausing":
      return ["halt", "cancel"];
    case "paused":
    case "halted":
      return ["resume", "cancel"];
    case "halting":
      return ["cancel"];
    default:
      return [];
  }
}
export function controlTransition(
  status: RunStatus,
  action: Control,
): { status: RunStatus; intent: RunIntent } {
  const repeated = {
    pause: ["pausing", "paused"],
    halt: ["halting", "halted"],
    resume: ["queued", "running"],
    cancel: ["cancelling", "cancelled"],
  };
  if (repeated[action].includes(status))
    return { status, intent: action === "resume" ? "run" : action };
  if (!allowedActions(status).includes(action))
    throw new AppError("invalid_state", `Cannot ${action} a ${status} run.`);
  const next: Record<Control, RunStatus> = {
    pause: "pausing",
    halt: "halting",
    resume: "queued",
    cancel: "cancelling",
  };
  return { status: next[action], intent: action === "resume" ? "run" : action };
}
export function isTerminal(status: RunStatus): boolean {
  return ["completed", "cancelled", "failed"].includes(status);
}
