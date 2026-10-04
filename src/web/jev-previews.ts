import type {
  JevAssessmentRecord,
  JevAssessmentSummary,
} from "../contracts.js";

export type JevPreview = JevAssessmentRecord | JevAssessmentSummary;
export function restoreJevPreviews(
  current: JevPreview[],
  saved: JevAssessmentSummary[],
): JevPreview[] {
  return [
    ...new Map(
      [
        ...saved.filter(
          (item) =>
            item.kind === "rejudge" &&
            !item.published &&
            item.status !== "pending",
        ),
        ...current,
      ].map((item) => [item.id, item]),
    ).values(),
  ];
}
