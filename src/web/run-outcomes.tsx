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
