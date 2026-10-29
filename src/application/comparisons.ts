import type { RunComparison } from "../contracts.js";
import { savedTarget } from "../contracts/targets.js";
import { digest } from "../domain/identity.js";
import { Database } from "../storage/database.js";
import { AnswerSources } from "./answer-sources.js";
import { AssessmentPassService, summarizePass } from "./assessment-passes.js";
import { runPerformance } from "./performance.js";
import { UsageProjection } from "./usage-projection.js";

/** Current logical availability and frozen assessment provenance share one projection. */
export class ComparisonService {
  constructor(
    private readonly db: Database,
    private readonly passes: AssessmentPassService,
    private readonly usage: UsageProjection,
  ) {}

  compare(runIds: string[], evaluatorRevisionId?: string): RunComparison {
    const warnings = new Set<string>();
    const fingerprints: string[] = [];
    const answers = new AnswerSources(this.db);
    const rows = runIds.map((runId) => {
      const run = this.db.require("run", runId);
      const target = savedTarget(run.manifest);
      const results = answers.results(runId);
      const scores = evaluatorRevisionId
        ? this.db
            .list("scoreSet", { runId })
            .filter(
              (item) =>
                item.published && item.evaluator.id === evaluatorRevisionId,
            )
            .at(-1)
        : undefined;
      const selectedId = evaluatorRevisionId
        ? undefined
        : (run.selectedAssessmentPassId ?? this.passes.list(runId)[0]?.id);
      const pass = scores
        ? this.passes.snapshotScores(runId, scores.id)
        : selectedId
          ? this.passes.get(runId, selectedId)
          : undefined;
      const slots = (ids: string[]) =>
        results
          .filter((result) => ids.includes(result.id))
          .map((result) => `${result.questionId}:${result.repetition}`)
          .sort();
      const questions = run.manifest.questions
        .map(({ expected: _expected, ...question }) => question)
        .sort((a, b) => a.id.localeCompare(b.id));
      const questionBasis = {
        publicQuestions: questions,
        references:
          pass?.basis.referenceHash ??
          digest(
            run.manifest.questions
              .map(({ id, expected }) => ({ id, expected }))
              .sort((a, b) => a.id.localeCompare(b.id)),
          ),
        eligible: slots(
          pass?.basis.eligibleResultIds ?? results.map((result) => result.id),
        ),
        excluded: slots(pass?.basis.excludedResultIds ?? []),
      };
      if (pass) {
        fingerprints.push(
          digest({
            source: pass.source,
            settings: {
              evaluator: pass.configuration.evaluator?.settings,
              judge: pass.configuration.judge,
              jev: pass.configuration.jevJudge
                ? {
                    model: pass.configuration.jevJudge.model,
                    settings: pass.configuration.jevJudge.profile.settings,
                  }
                : undefined,
            },
            ...questionBasis,
          }),
        );
        if (pass.status !== "completed")
          warnings.add("Some selected runs or assessments are incomplete.");
        if (pass.coverage.eligible === 0)
          warnings.add(
            "No eligible question slots remain under the selected assessment policy.",
          );
      } else {
        warnings.add(
          "Evaluator revisions differ or the selected revision has not been scored.",
        );
      }
      if (run.status !== "completed")
        warnings.add("Some selected runs or assessments are incomplete.");
      if (
        evaluatorRevisionId &&
        pass &&
        pass.coverage.judged !== pass.coverage.eligible
      )
        warnings.add(
          "Some runs have missing answers or unavailable deterministic assessments.",
        );
      return {
        runId,
        name: run.name,
        target,
        status: run.status,
        model: target.kind === "managed" ? target.agent.model : null,
        harness: target.kind === "managed" ? target.agent.harness : null,
        bankRevisionId: pass?.basis.bankRevisionId ?? run.manifest.bank.id,
        questionDigest: digest(questionBasis),
        evaluatorRevisionId: pass?.basis.evaluatorRevisionId ?? null,
        scoreSetId: scores?.id ?? pass?.id ?? null,
        accuracy: pass?.accuracy ?? null,
        graded: pass?.coverage.judged ?? 0,
        unscorable: pass?.coverage.excluded ?? 0,
        completed: results.filter((result) => result.answerSource).length,
        failed: results.filter(
          (result) => result.status === "failed" && !result.answerSource,
        ).length,
        total: results.length,
        repetitions: run.manifest.repetitions,
        ...(pass ? { assessmentPass: summarizePass(pass) } : {}),
        performance: runPerformance(this.db, runId, this.usage),
      };
    });
    if (new Set(fingerprints).size > 1)
      warnings.add(
        "Selected assessment sources, settings, reference answers, or eligible question slots differ.",
      );
    if (
      evaluatorRevisionId &&
      new Set(rows.map((row) => row.questionDigest)).size > 1
    )
      warnings.add(
        "Question sets, public answer formats, or expected answers differ.",
      );
    return { comparable: warnings.size === 0, warnings: [...warnings], rows };
  }
}
