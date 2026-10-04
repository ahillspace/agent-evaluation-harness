import type { RunSummary } from "../contracts.js";

export function RunOutcomes({
  completed,
  total,
  failed,
}: Pick<RunSummary, "completed" | "total" | "failed">) {
  const unanswered = total - completed - failed;
  return (
    <>
      <span>{`${completed} / ${total} answered`}</span>
      <small>{`${failed} execution failure${failed === 1 ? "" : "s"}`}</small>
      {unanswered > 0 && <small>{`${unanswered} unanswered`}</small>}
    </>
  );
}

export function RunAccuracy({
  accuracy,
  graded,
  unscorable = 0,
}: Pick<RunSummary, "accuracy" | "graded"> & { unscorable?: number }) {
  return (
    <>
      <span>
        {accuracy === null ? "Not graded" : `${(accuracy * 100).toFixed(1)}%`}
      </span>
      <small>{`${graded} scored answer${graded === 1 ? "" : "s"}`}</small>
      {unscorable > 0 && (
        <small>{`${unscorable} unscorable answer${unscorable === 1 ? "" : "s"} excluded`}</small>
      )}
    </>
  );
}
