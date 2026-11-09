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

type Lifecycle = { status: RunStatus; intent: RunIntent };
export function cancellationRequested(current: Lifecycle): boolean {
  return (
    current.intent === "cancel" ||
    ["cancelling", "cancelled"].includes(current.status)
  );
}
export function faultTransition(
  current: Lifecycle,
  settled = false,
): Lifecycle {
  return cancellationRequested(current)
    ? { status: settled ? "cancelled" : "cancelling", intent: "cancel" }
    : { status: settled ? "failed" : "halting", intent: "halt" };
}

export function settlementStatus(
  current: Lifecycle,
  unfinished: boolean,
  fatalStop = false,
): Extract<
  RunStatus,
  "completed" | "cancelled" | "failed" | "paused" | "halted"
> {
  if (cancellationRequested(current)) return "cancelled";
  if (current.status === "failed") return "failed";
  if (fatalStop) return "halted";
  if (!unfinished) return "completed";
  return current.intent === "pause" ? "paused" : "halted";
}
