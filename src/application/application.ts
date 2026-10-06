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
import { AssessmentPassService, summarizePass } from "./assessment-passes.js";
import { BankFindingService } from "./bank-findings.js";
import { UsageProjection } from "./usage-projection.js";
import { runPerformance } from "./performance.js";
import { digest } from "../domain/identity.js";
import { CatalogService } from "./catalog.js";
import {
  accuracy,
  gradedCount,
  unscorableCount,
  EvaluationService,
} from "./evaluations.js";
import { ResearchService } from "./research.js";
import { RunService } from "./runs.js";
import { JevService } from "./jev.js";
import { savedTarget } from "../contracts/targets.js";

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
  const usage = new UsageProjection(
    db,
    runtime.normalizeRecordedUsage?.bind(runtime),
  );
  const runs = new RunService(
    db,
    runtime,
    evaluations,
    options.dataDirectory,
    jev,
    usage,
  );
  const research = new ResearchService(
    db,
    runtime,
    runs,
    evaluations,
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
  function listRuns(limit = 100, offset = 0) {
    const records = db.list("run", { limit, offset, descending: true });
    const items = records.map((run) => {
      const target = savedTarget(run.manifest);
      const assessmentPasses = passes.list(run.id);
      const selectedAssessmentPassId =
        run.selectedAssessmentPassId ?? assessmentPasses[0]?.id;
      const selectedAssessment = assessmentPasses.find(
        (pass) => pass.id === selectedAssessmentPassId,
      );
      const results = db.list("result", { runId: run.id });
      const assessments = evaluations
        .summaries(run.id)
        .find((scores) => scores.kind === "original")!.assessments;
      return {
        id: run.id,
        assessmentPasses: assessmentPasses.map(summarizePass),
        selectedAssessmentPassId,
        performance: runPerformance(db, run.id, usage),
        name: run.name,
        status: run.status,
        createdAt: run.createdAt,
        ...(run.retryOf ? { retryOf: run.retryOf } : {}),
        bankName: run.manifest.bank.name,
        bankId: run.manifest.bank.bankId,
        model: target.kind === "managed" ? target.agent.model : null,
        harness: target.kind === "managed" ? target.agent.harness : null,
        target: savedTarget(run.manifest),
        completed: results.filter((r) => r.status === "completed").length,
        failed: results.filter((r) => r.status === "failed").length,
        graded: selectedAssessment?.coverage.judged ?? gradedCount(assessments),
        unscorable:
          selectedAssessment?.coverage.excluded ?? unscorableCount(assessments),
        total: results.length,
        accuracy:
          selectedAssessment?.accuracy ??
          (selectedAssessment ? null : accuracy(assessments)),
        ...(run.researchSessionId
          ? { researchSessionId: run.researchSessionId }
          : {}),
      };
    });
    const total = db.count("run");
    return {
      runs: items,
      total,
      nextOffset: offset + items.length < total ? offset + items.length : null,
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
      case "runs.assessment":
      case "runs.export-assessment": {
        const value = commandSchemas[command].parse(input);
        return passes.get(value.runId, value.passId);
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
      case "jev.get":
        return db.require(
          "jevAssessment",
          commandSchemas["jev.get"].parse(input).assessmentId,
        );
      case "workspace.get":
        commandSchemas["workspace.get"].parse(input);
        return workspace();
      case "runtime.discover":
        commandSchemas["runtime.discover"].parse(input);
        return runtime.discover();
      case "banks.create":
        return catalog.createBank(commandSchemas["banks.create"].parse(input));
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
        return listRuns(value.limit, value.offset);
      }
      case "runs.get": {
        const value = commandSchemas["runs.get"].parse(input);
        return {
          ...passes.enrich(runs.view(value.runId, value.cursor)),
          performance: runPerformance(db, value.runId, usage),
        };
      }
      case "runs.observe": {
        const value = commandSchemas["runs.observe"].parse(input);
        return {
          ...passes.enrich(runs.observe(value.runId, value.cursor)),
          performance: runPerformance(db, value.runId, usage),
        };
      }
      case "runs.attempt": {
        const value = commandSchemas["runs.attempt"].parse(input);
        return runs.attempt(value.runId, value.attemptId);
      }
      case "runs.attempt-events": {
        const value = commandSchemas["runs.attempt-events"].parse(input);
        const attempt = db.require("attempt", value.attemptId);
        if (attempt.runId !== value.runId)
          throw new AppError(
            "not_found",
            "The attempt does not belong to this run.",
          );
        const events = db.events(
          { runId: value.runId, attemptId: value.attemptId },
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
      case "runs.rescore": {
        const value = commandSchemas["runs.rescore"].parse(input);
        return evaluations.rescore(
          value.runId,
          value.evaluatorRevisionId,
          value.publish,
          value.bankRevisionId,
        );
      }
      case "runs.publish-score": {
        const value = commandSchemas["runs.publish-score"].parse(input);
        return evaluations.publish(value.runId, value.scoreSetId);
      }
      case "runs.review":
        return evaluations.review(commandSchemas["runs.review"].parse(input));
      case "runs.compare": {
        const value = commandSchemas["runs.compare"].parse(input);
        const comparison = evaluations.compare(
          value.runIds,
          value.evaluatorRevisionId,
        );
        if (value.evaluatorRevisionId) return comparison;
        const fingerprints: string[] = [];
        const rows = comparison.rows.map((row) => {
          const run = db.require("run", row.runId);
          const selectedId =
            run.selectedAssessmentPassId ?? passes.list(row.runId)[0]!.id;
          const pass = passes.get(row.runId, selectedId);
          const results = db.list("result", { runId: row.runId });
          const slots = (ids: string[]) =>
            results
              .filter((r) => ids.includes(r.id))
              .map((r) => `${r.questionId}:${r.repetition}`)
              .sort();
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
              questions: run.manifest.questions
                .map(({ expected: _expected, ...question }) => question)
                .sort((a, b) => a.id.localeCompare(b.id)),
              referenceHash: pass.basis.referenceHash,
              eligible: slots(pass.basis.eligibleResultIds),
              excluded: slots(pass.basis.excludedResultIds),
            }),
          );
          return {
            ...row,
            accuracy: pass.accuracy,
            graded: pass.coverage.judged,
            unscorable: pass.coverage.excluded,
            scoreSetId: pass.id,
            questionDigest: digest({
              publicQuestions: run.manifest.questions.map(
                ({ expected: _expected, ...question }) => question,
              ),
              references: pass.basis.referenceHash,
              eligible: slots(pass.basis.eligibleResultIds),
            }),
            evaluatorRevisionId: pass.basis.evaluatorRevisionId,
            bankRevisionId: pass.basis.bankRevisionId,
            assessmentPass: summarizePass(pass),
            performance: runPerformance(db, row.runId, usage),
          };
        });
        const warnings: string[] = [];
        if (
          rows.some(
            (row) =>
              row.status !== "completed" ||
              row.assessmentPass.status === "running",
          )
        )
          warnings.push("Some selected runs or assessments are incomplete.");
        if (rows.some((row) => row.assessmentPass.coverage.eligible === 0))
          warnings.push(
            "No eligible question slots remain under the selected assessment policy.",
          );
        if (new Set(fingerprints).size > 1)
          warnings.push(
            "Selected assessment sources, settings, reference answers, or eligible question slots differ.",
          );
        return {
          ...comparison,
          rows,
          warnings,
          comparable: warnings.length === 0,
        };
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
