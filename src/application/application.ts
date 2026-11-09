import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  commandSchemas,
  type CommandInput,
  type CommandName,
  type CommandResultMap,
  type RuntimePort,
  type WorkspaceView,
} from "../contracts.js";
import { AppError } from "../domain/errors.js";
import { Database } from "../storage/database.js";
import { acquireOwnerLock } from "../storage/owner-lock.js";
import { AssessmentPassService } from "./assessment-passes.js";
import { BankFindingService } from "./bank-findings.js";
import { UsageProjection } from "./usage-projection.js";
import { runPerformance } from "./performance.js";
import { CatalogService } from "./catalog.js";
import { EvaluationService } from "./evaluations.js";
import { ComparisonService } from "./comparisons.js";
import { ResearchService } from "./research.js";
import { RunService } from "./runs.js";
import { JevService } from "./jev.js";
import { AnswerSources } from "./answer-sources.js";
import { RetryApplicationService } from "./retry-applications.js";

export interface Application {
  execute<K extends CommandName>(
    operation: K,
    input: CommandInput<K>,
  ): Promise<CommandResultMap[K]>;
  execute(operation: string, input: unknown): Promise<unknown>;
  waitForIdle(): Promise<void>;
  close(): Promise<void>;
}
async function dispose(
  actions: Array<() => void | Promise<void>>,
  primaryError?: unknown,
): Promise<void> {
  const errors: unknown[] = primaryError === undefined ? [] : [primaryError];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }
  if (primaryError !== undefined && errors.length === 1) throw primaryError;
  if (errors.length)
    throw new AggregateError(
      errors,
      "Engine cleanup failed. Inspect the collected errors before restarting.",
    );
}
export async function createApplication(options: {
  dataDirectory: string;
  runtime: RuntimePort;
}): Promise<Application> {
  await mkdir(options.dataDirectory, { recursive: true });
  const releaseLock = await acquireOwnerLock(options.dataDirectory);
  const runtime = options.runtime;
  let database: Database | undefined;
  try {
    database = new Database(join(options.dataDirectory, "workspace.sqlite"));
    const recovery = await runtime.recover();
    if (recovery.errors.length)
      throw new AppError(
        "cleanup_failed",
        `Process recovery failed: ${recovery.errors.join("; ")}`,
      );
  } catch (error) {
    await dispose(
      [() => runtime.close(), () => database?.close(), releaseLock],
      error,
    );
    throw error;
  }
  const db = database;
  const catalog = new CatalogService(db);
  const evaluations = new EvaluationService(db);
  const jev = new JevService(db, runtime);
  const passes = new AssessmentPassService(
    db,
    evaluations,
    jev,
    runtime,
    options.dataDirectory,
  );
  const findings = new BankFindingService(db, catalog, passes);
  const answers = new AnswerSources(db);
  const retryApplications = new RetryApplicationService(
    db,
    passes,
    evaluations,
  );
  const usage = new UsageProjection(
    db,
    runtime.normalizeRecordedUsage?.bind(runtime),
  );
  const comparisons = new ComparisonService(db, passes, usage);
  const runs = new RunService(
    db,
    runtime,
    evaluations,
    options.dataDirectory,
    jev,
    passes,
    usage,
  );
  const research = new ResearchService(
    db,
    runtime,
    runs,
    passes,
    options.dataDirectory,
  );
  try {
    await jev.recover();
    await runs.recover();
    await evaluations.recover();
    passes.recover();
    research.recover();
  } catch (error) {
    await dispose(
      [() => runtime.close(), () => db.close(), releaseLock],
      error,
    );
    throw error;
  }
  let closed = false;
  const shutdownController = new AbortController();
  const admitted = new Set<Promise<unknown>>();
  let shutdown: Promise<void> | undefined;
  function listRuns(query: CommandInput<"runs.list"> = {}) {
    const page = db.runPage(query);
    return {
      ...page,
      runs: page.runs.map((run) => {
        const assessmentPasses = passes.summaries(run.id);
        const selectedAssessmentPassId =
          run.selectedAssessmentPassId ?? assessmentPasses[0]?.id;
        const selectedAssessment = assessmentPasses.find(
          (pass) => pass.id === selectedAssessmentPassId,
        );
        return {
          ...run,
          assessmentPasses,
          selectedAssessmentPassId,
          ...db.runOutcomeCounts(run.id),
          graded: selectedAssessment?.coverage.judged ?? 0,
          unscorable: selectedAssessment?.coverage.excluded ?? 0,
          accuracy: selectedAssessment?.accuracy ?? null,
        };
      }),
    };
  }
  async function workspace(): Promise<WorkspaceView> {
    const summaries = listRuns();
    return {
      workspaceId: db.workspaceId(),
      banks: db.list("bank").map((bank) => {
        const revision = db.require("bankRevision", bank.latestRevisionId);
        return {
          ...bank,
          questionCount: revision.questions.length,
          latestRevisionNumber: revision.number,
        };
      }),
      runs: summaries.runs,
      totalRuns: summaries.total,
      blueprints: db.list("blueprint"),
      researchSessions: db
        .list("research")
        .map(({ id, name, status, currentRunId, bestRunId, createdAt }) => ({
          id,
          name,
          status,
          currentRunId,
          bestRunId,
          createdAt,
        })),
      connections: await runtime.listConnections(),
    };
  }
  function execute<K extends CommandName>(
    operation: K,
    input: CommandInput<K>,
  ): Promise<CommandResultMap[K]>;
  function execute(operation: string, input: unknown): Promise<unknown>;
  function execute(operation: string, input: unknown): Promise<unknown> {
    if (closed)
      return Promise.reject(
        new AppError("unavailable", "The engine has closed."),
      );
    const task = dispatch(operation, input);
    admitted.add(task);
    void task.then(
      () => admitted.delete(task),
      () => admitted.delete(task),
    );
    return task;
  }
  async function dispatch(operation: string, input: unknown): Promise<unknown> {
    if (!Object.hasOwn(commandSchemas, operation))
      throw new AppError(
        "unknown_operation",
        `Unknown operation: ${operation}`,
      );
    const command = operation as CommandName;
    switch (command) {
      case "runs.assess":
        return passes.create(
          commandSchemas["runs.assess"].parse(input),
          shutdownController.signal,
        );
      case "runs.assessment": {
        const value = commandSchemas[command].parse(input);
        return passes.read(
          value.runId,
          value.passId,
          value.expectedObservationRevision,
        );
      }
      case "runs.export-assessment": {
        const value = commandSchemas[command].parse(input);
        return passes.get(
          value.runId,
          value.passId,
          value.expectedObservationRevision,
        );
      }
      case "runs.select-assessment": {
        const value = commandSchemas[command].parse(input);
        return passes.select(value.runId, value.passId);
      }
      case "runs.retry-assessment":
        return passes.retry(
          commandSchemas[command].parse(input),
          shutdownController.signal,
        );
      case "runs.review-assessment":
        return passes.review(commandSchemas[command].parse(input));
      case "banks.findings":
        return findings.list(commandSchemas[command].parse(input).bankId);
      case "banks.report-finding":
        return findings.report(commandSchemas[command].parse(input));
      case "banks.resolve-finding":
        return findings.resolve(commandSchemas[command].parse(input));
      case "jev.profiles.publish":
        return jev.publishProfile(
          commandSchemas["jev.profiles.publish"].parse(input),
        );
      case "jev.profiles.activate": {
        const value = commandSchemas["jev.profiles.activate"].parse(input);
        return jev.activate(value.bankId, value.profileRevisionId);
      }
      case "jev.preview":
        return jev.preview(commandSchemas["jev.preview"].parse(input));
      case "jev.publish":
        return jev.publish(
          commandSchemas["jev.publish"].parse(input).assessmentId,
        );
      case "jev.get": {
        const value = commandSchemas["jev.get"].parse(input);
        const context = value.assessmentContext;
        return context
          ? passes.readJev(
              context.runId,
              context.passId,
              value.assessmentId,
              context.expectedObservationRevision,
            )
          : db.require("jevAssessment", value.assessmentId);
      }
      case "workspace.get":
        commandSchemas["workspace.get"].parse(input);
        return workspace();
      case "runtime.discover":
        commandSchemas["runtime.discover"].parse(input);
        return runtime.discover();
      case "banks.create":
        return catalog.createBank(commandSchemas["banks.create"].parse(input));
      case "banks.publish":
        return catalog.publishBank(
          commandSchemas["banks.publish"].parse(input),
        );
      case "banks.check-answer":
        return evaluations.checkAnswer(
          commandSchemas["banks.check-answer"].parse(input),
        );
      case "banks.calibrate-draft":
        return evaluations.calibrateDraft(
          commandSchemas["banks.calibrate-draft"].parse(input),
        );
      case "banks.preview-draft": {
        const value = commandSchemas["banks.preview-draft"].parse(input);
        return evaluations.previewDraft(
          value,
          new Map(
            value.runIds.map((runId) => [
              runId,
              passes.originalDeterministicVerdicts(runId),
            ]),
          ),
        );
      }
      case "banks.export-package":
        return catalog.exportPackage(
          commandSchemas["banks.export-package"].parse(input),
        );
      case "banks.get": {
        const value = commandSchemas["banks.get"].parse(input);
        return {
          bank: db.require("bank", value.bankId),
          revisions: db.list("bankRevision", { bankId: value.bankId }),
          evaluatorRevisions: db.list("evaluator", { bankId: value.bankId }),
          evaluatorDrafts: db.list("evaluatorDraft", { bankId: value.bankId }),
          jevProfiles: db.list("jevProfile", { bankId: value.bankId }),
        };
      }
      case "banks.revise":
        return catalog.reviseBank(commandSchemas["banks.revise"].parse(input));
      case "banks.export": {
        const value = commandSchemas["banks.export"].parse(input);
        return db.require("bankRevision", value.bankRevisionId);
      }
      case "evaluators.draft":
        return catalog.saveDraft(
          commandSchemas["evaluators.draft"].parse(input),
        );
      case "evaluators.publish": {
        const value = commandSchemas["evaluators.publish"].parse(input);
        return catalog.publishDraft(value.draftId, value.activate);
      }
      case "evaluators.activate": {
        const value = commandSchemas["evaluators.activate"].parse(input);
        return catalog.activate(value.bankId, value.evaluatorRevisionId);
      }
      case "evaluators.preview": {
        const value = commandSchemas["evaluators.preview"].parse(input);
        return evaluations.preview(
          value.draftId,
          value.runIds,
          value.bankRevisionId,
          new Map(
            value.runIds.map((runId) => [
              runId,
              passes.originalDeterministicVerdicts(runId),
            ]),
          ),
        );
      }
      case "evaluators.calibrate": {
        const value = commandSchemas["evaluators.calibrate"].parse(input);
        return evaluations.calibrate(value.draftId, value.bankRevisionId);
      }
      case "runs.launch":
        return runs.launch(commandSchemas["runs.launch"].parse(input));
      case "runs.list": {
        const value = commandSchemas["runs.list"].parse(input);
        return listRuns(value);
      }
      case "runs.get": {
        const value = commandSchemas["runs.get"].parse(input);
        return {
          ...retryApplications.enrich(
            passes.enrich(runs.view(value.runId, value.cursor)),
          ),
          performance: runPerformance(db, value.runId, usage),
        };
      }
      case "runs.observe": {
        const value = commandSchemas["runs.observe"].parse(input);
        return {
          ...retryApplications.enrich(
            passes.enrich(runs.observe(value.runId, value.cursor)),
          ),
          performance: runPerformance(db, value.runId, usage),
        };
      }
      case "runs.attempt": {
        const value = commandSchemas["runs.attempt"].parse(input);
        return runs.attempt(
          value.runId,
          value.attemptId,
          value.expectedEvidenceHash,
        );
      }
      case "runs.attempt-events": {
        const value = commandSchemas["runs.attempt-events"].parse(input);
        const { attempt } = answers.authorize(value.runId, value.attemptId);
        const events = db.events(
          { runId: attempt.runId, attemptId: value.attemptId },
          value.cursor,
          { limit: 200 },
        );
        return { events, cursor: events.at(-1)?.sequence ?? value.cursor };
      }
      case "runs.events": {
        const value = commandSchemas["runs.events"].parse(input);
        db.require("run", value.runId);
        const events = db.events({ runId: value.runId }, value.cursor, {
          summary: true,
          limit: 200,
        });
        return { events, cursor: events.at(-1)?.sequence ?? value.cursor };
      }
      case "runs.retry-failed":
        return runs.retryFailed(
          commandSchemas["runs.retry-failed"].parse(input),
        );
      case "runs.apply-retry":
        return retryApplications.apply(
          commandSchemas["runs.apply-retry"].parse(input),
        );
      case "runs.control": {
        const value = commandSchemas["runs.control"].parse(input);
        const run = db.require("run", value.runId);
        if (run.researchSessionId) {
          research.control(run.researchSessionId, value.action);
          return runs.view(value.runId);
        }
        return runs.control(
          value.runId,
          value.action,
          value.acknowledgeDuplicateWork,
        );
      }
      case "runs.export-agent":
        return runs.exportAgent(
          commandSchemas["runs.export-agent"].parse(input).runId,
        );
      case "runs.export-target":
        return runs.exportTarget(
          commandSchemas["runs.export-target"].parse(input).runId,
        );
      case "targets.list":
        return runtime.externalTargets.list();
      case "targets.save":
        return runtime.externalTargets.save(
          commandSchemas["targets.save"].parse(input),
        );
      case "targets.delete":
        await runtime.externalTargets.delete(
          commandSchemas["targets.delete"].parse(input).targetId,
        );
        return { ok: true };
      case "targets.preview": {
        const value = commandSchemas["targets.preview"].parse(input);
        return runtime.previewTarget(value.target, value.question);
      }
      case "targets.sample":
        return runs.sample(
          commandSchemas["targets.sample"].parse(input),
          shutdownController.signal,
        );
      case "runs.compare": {
        const value = commandSchemas["runs.compare"].parse(input);
        return comparisons.compare(value.runIds, value.evaluatorRevisionId);
      }
      case "blueprints.save": {
        const value = commandSchemas["blueprints.save"].parse(input);
        return catalog.saveBlueprint(value.name, value.runId);
      }
      case "blueprints.delete":
        db.delete(
          "blueprint",
          commandSchemas["blueprints.delete"].parse(input).blueprintId,
        );
        return { deleted: true };
      case "connections.save":
        return runtime.saveConnection(
          commandSchemas["connections.save"].parse(input),
        );
      case "connections.delete":
        await runtime.deleteConnection(
          commandSchemas["connections.delete"].parse(input).connectionId,
        );
        return { deleted: true };
      case "connections.resources": {
        const value = commandSchemas["connections.resources"].parse(input);
        if (!runtime.listConnectionResources)
          throw new AppError(
            "unavailable",
            "This runtime does not support browsing connection resources.",
          );
        return runtime.listConnectionResources(value);
      }
      case "connections.test":
        return runtime.testConnection(
          commandSchemas["connections.test"].parse(input).connectionId,
        );
      case "research.launch":
        return research.launch(commandSchemas["research.launch"].parse(input));
      case "research.get": {
        const value = commandSchemas["research.get"].parse(input);
        return research.view(value.sessionId, value.cursor);
      }
      case "research.turn": {
        const value = commandSchemas["research.turn"].parse(input);
        const turn = db.require("research", value.sessionId).turns[value.index];
        if (!turn)
          throw new AppError(
            "not_found",
            "The requested researcher turn does not exist.",
          );
        return turn;
      }
      case "research.control": {
        const value = commandSchemas["research.control"].parse(input);
        return research.control(value.sessionId, value.action);
      }
      case "research.evidence": {
        const value = commandSchemas["research.evidence"].parse(input);
        return research.evidence(value.sessionId, value);
      }
    }
    const unhandled: never = command;
    throw new AppError("unknown_operation", `Unhandled command: ${unhandled}`);
  }
  return {
    execute,
    async waitForIdle() {
      await research.waitForIdle();
      await runs.waitForIdle();
    },
    close() {
      if (shutdown) return shutdown;
      closed = true;
      shutdownController.abort(new Error("The engine is shutting down."));
      shutdown = (async () => {
        await Promise.allSettled([...admitted]);
        await dispose([
          () => research.close(),
          () => runs.close(),
          () => runtime.close(),
          () => db.close(),
          releaseLock,
        ]);
      })();
      return shutdown;
    },
  };
}
