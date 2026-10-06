import type { Blueprint, ResearchInput, RunRecord } from "../contracts.js";
import { restoreSetup, type SetupDraft } from "./drafts.js";
import { restoreResearchSetup } from "./setup-draft.js";

/** Restore public run settings through the same path for runs and their saved blueprints. */
export async function hydrateSetupSource(
  source: { runId?: string; blueprint?: Blueprint },
  read: {
    run: (id: string) => Promise<RunRecord>;
    research: (id: string) => Promise<ResearchInput>;
  },
): Promise<SetupDraft> {
  const runId = source.runId ?? source.blueprint?.sourceRunId;
  const run = runId ? await read.run(runId) : undefined;
  if (!run && !source.blueprint)
    throw new Error("The requested setup source is unavailable.");
  let draft = restoreSetup(source.blueprint ?? run!);
  if (run && source.blueprint) {
    const basis = restoreSetup(run);
    draft = {
      ...draft,
      bankId: basis.bankId,
      bankRevisionId: basis.bankRevisionId,
      evaluatorRevisionId: basis.evaluatorRevisionId,
      questionIds: basis.questionIds,
      questionSelection: basis.questionSelection,
    };
  }
  if (run?.researchSessionId)
    draft = restoreResearchSetup(
      draft,
      await read.research(run.researchSessionId),
    );
  return draft;
}
