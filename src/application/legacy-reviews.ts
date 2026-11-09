import {
  jsonSchema,
  type AssessmentPass,
  type HumanReview,
} from "../contracts.js";
import { digest } from "../domain/identity.js";
import { Database } from "../storage/database.js";
import {
  measurePass,
  type AssessmentPassService,
} from "./assessment-passes.js";

/** Translates missing historical answer identity into an explicit unresolved review. */
function unresolvedReview(
  parent: AssessmentPass,
  review: HumanReview,
  passId: string,
): AssessmentPass {
  const judgments = parent.judgments.map((judgment) => {
    if (judgment.resultId !== review.resultId) return judgment;
    return {
      resultId: judgment.resultId,
      status: "unjudged" as const,
      explanation:
        "The historical review does not identify a sealed answer source. Its recorded decision remains available, but answer provenance is unresolved.",
      details: {
        legacyReview: jsonSchema.parse(review),
        provenance: "unresolved",
      },
      review: {
        reviewer: review.reviewer,
        note: review.note,
        createdAt: review.createdAt,
        previousStatus: judgment.status,
      },
    };
  });
  return measurePass({
    ...parent,
    id: passId,
    parentPassId: parent.id,
    name: `Human review by ${review.reviewer} (${review.createdAt})`,
    source: "human",
    status: "completed",
    createdAt: review.createdAt,
    finishedAt: review.createdAt,
    judgments,
    basis: {
      ...parent.basis,
      eligibleResultIds: judgments
        .filter((judgment) => judgment.status !== "excluded")
        .map((judgment) => judgment.resultId),
      excludedResultIds: judgments
        .filter((judgment) => judgment.status === "excluded")
        .map((judgment) => judgment.resultId),
    },
  });
}

/** Imports the retired row-review format atomically per Run without changing historical records. */
export function restoreLegacyReviews(
  db: Database,
  passes: AssessmentPassService,
): void {
  const runs = new Map<string, HumanReview[]>();
  for (const review of db.list("review")) {
    const reviews = runs.get(review.runId) ?? [];
    reviews.push(review);
    runs.set(review.runId, reviews);
  }
  for (const [runId, reviews] of runs)
    db.transaction(() => {
      const parents = new Map<string, AssessmentPass>();
      let latest: AssessmentPass | undefined;
      reviews.sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      );
      for (const review of reviews) {
        const basis = review.scoreSetId ?? `original_${runId}`;
        const passId = `legacy_review_${digest(review.id).slice(0, 32)}`;
        let pass = db.get("assessmentPass", passId);
        if (!pass) {
          const parent =
            parents.get(basis) ?? passes.snapshotLegacyScore(runId, basis);
          const judgment = parent.judgments.find(
            (item) => item.resultId === review.resultId,
          );
          const attempt = judgment?.attemptId
            ? db.get("attempt", judgment.attemptId)
            : undefined;
          const sealed =
            attempt?.status === "completed" &&
            attempt.output &&
            judgment?.evidenceHash &&
            digest(attempt.output) === judgment.evidenceHash;
          pass = sealed
            ? passes.review(
                {
                  runId,
                  parentPassId: parent.id,
                  name: `Human review by ${review.reviewer} (${review.createdAt})`,
                  reviewer: review.reviewer,
                  overrides: [
                    {
                      resultId: review.resultId,
                      verdict: review.verdict,
                      note: review.note,
                    },
                  ],
                },
                { id: passId, createdAt: review.createdAt, select: false },
              )
            : db.insert(
                "assessmentPass",
                unresolvedReview(parent, review, passId),
              );
        }
        parents.set(basis, pass);
        latest = pass;
      }
      // Existing migrated passes also restore a selection lost in an older interrupted migration.
      if (latest && !db.require("run", runId).selectedAssessmentPassId)
        passes.select(runId, latest.id);
    });
}
