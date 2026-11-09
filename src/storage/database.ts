import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  AnswerSource,
  AssessmentPassSummary,
  RunSummary,
  Assessment,
  UsageReport,
  AssessmentPass,
  BankFinding,
  AttemptRecord,
  AttemptSummary,
  Bank,
  BankRevision,
  Blueprint,
  EvaluatorDraft,
  EvaluatorRevision,
  HumanReview,
  Json,
  ObservationEvent,
  ResearchRecord,
  ResultRecord,
  RunRecord,
  ScoreSet,
  ResearchSummary,
  AttemptDetail,
  JevProfileRevision,
  JevAssessmentRecord,
  JevAssessmentSummary,
  RunRetryApplication,
} from "../contracts.js";
import { digest, id } from "../domain/identity.js";
import { AppError } from "../domain/errors.js";
import { canonical, now } from "../domain/identity.js";

export interface RecordMap {
  retryApplication: RunRetryApplication;
  assessmentPass: AssessmentPass;
  bankFinding: BankFinding;
  bank: Bank;
  bankRevision: BankRevision;
  evaluator: EvaluatorRevision;
  evaluatorDraft: EvaluatorDraft;
  run: RunRecord;
  result: ResultRecord;
  attempt: AttemptRecord;
  assessment: Assessment & { id: string; runId?: string };
  scoreSet: ScoreSet;
  review: HumanReview;
  blueprint: Blueprint;
  research: ResearchRecord;
  jevProfile: JevProfileRevision;
  jevAssessment: JevAssessmentRecord;
}
export type RecordKind = keyof RecordMap;
export interface RecordQuery {
  ids?: string[];
  runId?: string | string[];
  resultId?: string;
  bankId?: string;
  researchSessionId?: string;
  parentRunId?: string;
  status?: string | string[];
  limit?: number;
  offset?: number;
  descending?: boolean;
}
const policies: Record<RecordKind, { appendOnly: boolean; fixed: string[] }> = {
  retryApplication: { appendOnly: true, fixed: [] },
  assessmentPass: {
    appendOnly: false,
    fixed: [
      "runId",
      "name",
      "source",
      "createdAt",
      "parentPassId",
      "retryApplicationId",
      "basis",
      "configuration",
    ],
  },
  bankFinding: {
    appendOnly: false,
    fixed: [
      "bankId",
      "bankRevisionId",
      "questionId",
      "kind",
      "title",
      "note",
      "createdAt",
      "runId",
      "resultId",
      "passId",
    ],
  },
  bank: { appendOnly: false, fixed: ["createdAt"] },
  bankRevision: { appendOnly: true, fixed: [] },
  evaluator: { appendOnly: true, fixed: [] },
  evaluatorDraft: { appendOnly: false, fixed: ["bankId", "createdAt"] },
  run: {
    appendOnly: false,
    fixed: ["manifest", "researchSessionId", "createdAt"],
  },
  result: { appendOnly: false, fixed: ["runId", "questionId", "repetition"] },
  attempt: {
    appendOnly: false,
    fixed: [
      "runId",
      "resultId",
      "number",
      "startedAt",
      "executionId",
      "budgetResearchSessionId",
    ],
  },
  assessment: { appendOnly: true, fixed: [] },
  scoreSet: {
    appendOnly: false,
    fixed: ["runId", "evaluator", "createdAt", "kind", "assessments"],
  },
  review: { appendOnly: true, fixed: [] },
  blueprint: {
    appendOnly: false,
    fixed: [
      "sourceRunId",
      "agent",
      "target",
      "repetitions",
      "limits",
      "judge",
      "createdAt",
    ],
  },
  research: { appendOnly: false, fixed: ["configuration", "createdAt"] },
  jevProfile: { appendOnly: true, fixed: [] },
  jevAssessment: {
    appendOnly: false,
    fixed: [
      "runId",
      "resultId",
      "attemptId",
      "createdAt",
      "kind",
      "configuration",
      "configurationHash",
      "evidenceHash",
      "attemptEvidenceHash",
      "bankRevisionId",
      "evaluatorRevisionId",
      "evidence",
      "criteria",
    ],
  },
};
export interface PassSummaryBasis {
  bankRevisionId: string;
  evaluatorRevisionId: string;
  referenceHash: string;
  defaultDisposition?: string;
  dispositions: Record<string, string>;
}
export interface ScoreSummaryInput {
  id: string;
  name: string;
  createdAt: string;
  basis: PassSummaryBasis;
  assessments: Array<{
    resultId: string;
    attemptId: string;
    deterministic: string;
    judgeVerdict: boolean | null;
    judgeError: boolean;
    judgeResponded: boolean;
  }>;
}
const comparisonDisposition = (settings: string) =>
  `json_object('defaultDisposition',json_extract(${settings},'$.referenceDisposition'),'dispositions',json(COALESCE((SELECT json_group_object(key,json_extract(value,'$.referenceDisposition')) FROM json_each(${settings},'$.questionOverrides') WHERE json_type(value,'$.referenceDisposition')='text'),'{}')))`;
const compactAssessment = (value: string) =>
  `json_object('resultId',json_extract(${value},'$.resultId'),'attemptId',json_extract(${value},'$.attemptId'),'deterministic',json_extract(${value},'$.deterministic.status'),'judgeVerdict',json(${value} -> '$.judge.verdict'),'judgeError',json_type(${value},'$.judgeError') IS NOT NULL,'judgeResponded',json_type(${value},'$.judge') IS NOT NULL OR json_type(${value},'$.judgeResponse') IS NOT NULL)`;
const referenceHash = (questions: string, selected: string) =>
  `reference_hash(COALESCE((SELECT json_group_array(json_object('id',json_extract(q.value,'$.id'),'expected',json(q.value -> '$.expected'))) FROM json_each(${questions}) q WHERE json_extract(q.value,'$.id') IN (SELECT json_extract(value,'$.id') FROM json_each(${selected}))),'[]'))`;
export type RunHeader = Pick<RunRecord, "id" | "name" | "status" | "retryOf">;
export type RunState = Omit<RunRecord, "manifest"> & {
  targetKind: "managed" | "external";
  targetHarness?: string;
  researchStatus?: ResearchRecord["status"];
};
export interface AutomaticAssessmentInput {
  result: ResultRecord;
  attemptId?: string;
  source?: AnswerSource;
  attempt?: Pick<
    AttemptRecord,
    "runId" | "resultId" | "status" | "finishedAt" | "evidenceHash"
  > & { hasOutput: boolean };
  owner?: Pick<ResultRecord, "runId" | "questionId" | "repetition">;
  sourceRun?: Pick<RunRecord, "id" | "retryOf"> & { sameManifest: boolean };
  raw?: {
    recordId?: string;
    scoreSetId?: string;
    assessment: Assessment;
    judgeResponded: boolean;
  };
  jev?: Pick<JevAssessmentRecord, "id" | "status" | "checks" | "usage"> & {
    criteria: Pick<JevAssessmentRecord["criteria"], "confidenceThreshold">;
    error?: { message: string };
  };
}
export type RunListQuery = {
  bankId?: string;
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
};
export const normalizeRunSearch = (value: string): string =>
  value.normalize("NFKC").toLowerCase();

const queryColumns = {
  runId: "run_id",
  resultId: "result_id",
  bankId: "bank_id",
  researchSessionId: "session_id",
  status: "status",
  parentRunId: "parent_run_id",
} as const;

type RecordFilter = Omit<RecordQuery, "limit" | "offset" | "descending">;
function recordFilter(
  kind: RecordKind,
  query: RecordFilter,
): { where: string; parameters: SQLInputValue[] } {
  const clauses = ["kind=?"];
  const parameters: SQLInputValue[] = [kind];
  if (query.ids !== undefined) {
    clauses.push("id IN (SELECT value FROM json_each(?))");
    parameters.push(JSON.stringify(query.ids));
  }
  for (const [key, column] of Object.entries(queryColumns)) {
    const value = query[key as keyof typeof queryColumns];
    if (value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    clauses.push(
      values.length ? `${column} IN (${values.map(() => "?").join(",")})` : "0",
    );
    parameters.push(...values);
  }
  return { where: clauses.join(" AND "), parameters };
}

export class Database {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.function("normalize_search", { deterministic: true }, (value) =>
      normalizeRunSearch(String(value ?? "")),
    );
    this.db.function("reference_hash", { deterministic: true }, (value) =>
      digest(
        (JSON.parse(String(value)) as Array<{ id: string }>).sort((a, b) =>
          a.id.localeCompare(b.id),
        ),
      ),
    );
    try {
      const version = Number(
        this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0,
      );
      if (version > 7)
        throw new AppError(
          "schema_version",
          "This catalog requires a newer application version.",
        );
      this.initialize(version);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private initialize(version: number): void {
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=OFF;
      PRAGMA busy_timeout=5000;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS ${version > 0 && version < 6 ? "records_v6" : "records"} (
        kind TEXT NOT NULL CHECK(kind IN (${Object.keys(policies)
          .map((kind) => `'${kind}'`)
          .join(",")})),
        id TEXT NOT NULL, value TEXT NOT NULL CHECK(json_valid(value) AND json_extract(value,'$.id')=id),
        immutable INTEGER NOT NULL DEFAULT 0, ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT GENERATED ALWAYS AS (json_extract(value,'$.runId')) VIRTUAL,
        result_id TEXT GENERATED ALWAYS AS (json_extract(value,'$.resultId')) VIRTUAL,
        bank_id TEXT GENERATED ALWAYS AS (json_extract(value,'$.bankId')) VIRTUAL,
        session_id TEXT GENERATED ALWAYS AS (json_extract(value,'$.researchSessionId')) VIRTUAL,
        status TEXT GENERATED ALWAYS AS (json_extract(value,'$.status')) VIRTUAL,
        UNIQUE(kind,id)
      );
    `);
    if (version > 0 && version < 6)
      this.db.exec(`
      INSERT INTO records_v6(kind,id,value,immutable,ordinal) SELECT kind,id,value,immutable,ordinal FROM records;
      DROP TABLE records;
      ALTER TABLE records_v6 RENAME TO records;
    `);
    if (version < 7) {
      this.db.exec(`
        ALTER TABLE records ADD COLUMN parent_run_id TEXT GENERATED ALWAYS AS (json_extract(value,'$.retryOf.runId')) VIRTUAL;
        ALTER TABLE records ADD COLUMN run_bank_id TEXT GENERATED ALWAYS AS (json_extract(value,'$.manifest.bank.bankId')) VIRTUAL;
      `);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS records_parent_run ON records(kind,parent_run_id,ordinal);
      CREATE INDEX IF NOT EXISTS records_run_bank ON records(kind,run_bank_id,ordinal);
      CREATE INDEX IF NOT EXISTS records_run_bank_status ON records(kind,run_bank_id,status,ordinal);
    `);
    if (version < 3)
      this.db.exec("DROP TRIGGER IF EXISTS immutable_blueprint_fields;");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS records_run ON records(kind,run_id,ordinal);
      CREATE INDEX IF NOT EXISTS records_result ON records(kind,result_id,ordinal);
      CREATE INDEX IF NOT EXISTS records_bank ON records(kind,bank_id,ordinal);
      CREATE INDEX IF NOT EXISTS records_session ON records(kind,session_id,ordinal);
      CREATE INDEX IF NOT EXISTS records_status ON records(kind,status,ordinal);
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, session_id TEXT,
        attempt_id TEXT, created_at TEXT NOT NULL, type TEXT NOT NULL,
        message TEXT NOT NULL, data TEXT
      );
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id,sequence);
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id,sequence);
      CREATE INDEX IF NOT EXISTS events_attempt ON events(attempt_id,sequence);
      CREATE INDEX IF NOT EXISTS events_run_control ON events(run_id,sequence) WHERE type='run.control.requested';
      CREATE INDEX IF NOT EXISTS events_session_control ON events(session_id,sequence) WHERE type='research.control.requested';
      CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, hash TEXT NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL, response TEXT CHECK(response IS NULL OR json_valid(response)),
        FOREIGN KEY(kind,record_id) REFERENCES records(kind,id));
      CREATE TRIGGER IF NOT EXISTS records_append_only BEFORE UPDATE ON records
      WHEN OLD.immutable=1 OR OLD.kind IN (${Object.entries(policies)
        .filter(([, policy]) => policy.appendOnly)
        .map(([kind]) => `'${kind}'`)
        .join(",")})
      BEGIN SELECT RAISE(ABORT,'Published records are immutable.'); END;
      CREATE TRIGGER IF NOT EXISTS records_keep_evidence BEFORE DELETE ON records
      WHEN OLD.kind NOT IN ('blueprint','evaluatorDraft')
      BEGIN SELECT RAISE(ABORT,'Evidence records cannot be deleted through catalog operations.'); END;
      CREATE TRIGGER IF NOT EXISTS completed_attempts_are_sealed BEFORE UPDATE ON records
      WHEN OLD.kind='attempt' AND json_extract(OLD.value,'$.status')='completed' AND OLD.value!=NEW.value
      BEGIN SELECT RAISE(ABORT,'Completed attempt evidence is immutable.'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_attempt_execution_fields BEFORE UPDATE ON records
      WHEN OLD.kind='attempt' AND (json_extract(OLD.value,'$.executionId') IS NOT json_extract(NEW.value,'$.executionId') OR json_extract(OLD.value,'$.budgetResearchSessionId') IS NOT json_extract(NEW.value,'$.budgetResearchSessionId'))
      BEGIN SELECT RAISE(ABORT,'Attempt execution attribution is immutable.'); END;
      CREATE TRIGGER IF NOT EXISTS assessment_passes_are_sealed BEFORE UPDATE ON records
      WHEN OLD.kind='assessmentPass' AND json_extract(OLD.value,'$.status')!='running' AND OLD.value!=NEW.value
      BEGIN SELECT RAISE(ABORT,'Completed assessment passes are immutable.'); END;
      CREATE TRIGGER IF NOT EXISTS score_publication_is_monotonic BEFORE UPDATE ON records
      WHEN OLD.kind='scoreSet' AND json_extract(OLD.value,'$.published')=1 AND json_extract(NEW.value,'$.published') IS NOT 1
      BEGIN SELECT RAISE(ABORT,'Published assessments cannot be unpublished.'); END;
      CREATE TRIGGER IF NOT EXISTS jev_results_are_sealed BEFORE UPDATE ON records
      WHEN OLD.kind='jevAssessment' AND json_extract(OLD.value,'$.status')!='pending'
        AND json_remove(OLD.value,'$.published')!=json_remove(NEW.value,'$.published')
      BEGIN SELECT RAISE(ABORT,'Completed judge assessments are immutable.'); END;
      CREATE TRIGGER IF NOT EXISTS jev_publication_is_monotonic BEFORE UPDATE ON records
      WHEN OLD.kind='jevAssessment' AND json_extract(OLD.value,'$.published')=1 AND json_extract(NEW.value,'$.published') IS NOT 1
      BEGIN SELECT RAISE(ABORT,'Published judge assessments cannot be unpublished.'); END;
    `);
    if (
      !this.db
        .prepare("PRAGMA table_info(idempotency)")
        .all()
        .some((column) => column.name === "response")
    )
      this.db.exec(
        "ALTER TABLE idempotency ADD COLUMN response TEXT CHECK(response IS NULL OR json_valid(response));",
      );
    for (const [kind, policy] of Object.entries(policies)) {
      if (!policy.fixed.length) continue;
      const changed = policy.fixed
        .map(
          (field) =>
            `json_extract(OLD.value,'$.${field}') IS NOT json_extract(NEW.value,'$.${field}')`,
        )
        .join(" OR ");
      this.db
        .exec(`CREATE TRIGGER IF NOT EXISTS immutable_${kind}_fields BEFORE UPDATE ON records
        WHEN OLD.kind='${kind}' AND (${changed})
        BEGIN SELECT RAISE(ABORT,'Frozen record fields are immutable.'); END;`);
    }
    if (this.db.prepare("PRAGMA foreign_key_check").all().length)
      throw new AppError(
        "schema_integrity",
        "Catalog references failed migration validation.",
      );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS workspace_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    );
    this.db
      .prepare(
        "INSERT OR IGNORE INTO workspace_metadata(key,value) VALUES ('id',?)",
      )
      .run(id("workspace"));
    this.db.exec("PRAGMA user_version=7; COMMIT; PRAGMA foreign_keys=ON;");
  }
  workspaceId(): string {
    return this.db
      .prepare("SELECT value FROM workspace_metadata WHERE key='id'")
      .get()!.value as string;
  }
  jevSummaries(runId: string): JevAssessmentSummary[] {
    return this.db
      .prepare(
        `SELECT json_set(json_remove(value,'$.evidence','$.criteria','$.request','$.response','$.attempts','$.fallback','$.configuration','$.configurationHash','$.evidenceHash','$.attemptEvidenceHash','$.bankRevisionId','$.evaluatorRevisionId','$.httpStatus','$.requestId'),
      '$.fallbackApplied',json(CASE WHEN json_type(value,'$.fallback')='object' THEN 'true' ELSE 'false' END),
      '$.fallbackUsage',json_extract(value,'$.fallback.trigger.usage'),
      '$.fallbackResultUsage',json_extract(value,'$.fallback.resultUsage'),
      '$.profileRevisionId',json_extract(value,'$.configuration.profile.id'),
      '$.profileRevisionNumber',json_extract(value,'$.configuration.profile.number'),
      '$.profileName',json_extract(value,'$.configuration.profile.name'),
      '$.confidenceThreshold',json_extract(value,'$.criteria.confidenceThreshold')) AS summary
      FROM records WHERE kind='jevAssessment' AND run_id=? ORDER BY ordinal`,
      )
      .all(runId)
      .map((row) => {
        const summary = JSON.parse(
          row.summary as string,
        ) as JevAssessmentSummary;
        if (summary.fallbackUsage == null) delete summary.fallbackUsage;
        if (summary.fallbackResultUsage == null)
          delete summary.fallbackResultUsage;
        return summary;
      });
  }
  insert<K extends RecordKind>(
    kind: K,
    record: RecordMap[K],
    immutable = false,
  ): RecordMap[K] {
    this.db
      .prepare("INSERT INTO records(kind,id,value,immutable) VALUES (?,?,?,?)")
      .run(
        kind,
        record.id,
        canonical(record),
        immutable || policies[kind].appendOnly ? 1 : 0,
      );
    return record;
  }
  update<K extends RecordKind>(kind: K, record: RecordMap[K]): RecordMap[K] {
    const result = this.db
      .prepare(
        "UPDATE records SET value=? WHERE kind=? AND id=? AND immutable=0",
      )
      .run(canonical(record), kind, record.id);
    if (result.changes !== 1)
      throw new AppError(
        "immutable_or_missing",
        `Cannot update ${kind} ${record.id}.`,
      );
    return record;
  }
  get<K extends RecordKind>(
    kind: K,
    recordId: string,
  ): RecordMap[K] | undefined {
    const row = this.db
      .prepare("SELECT value FROM records WHERE kind=? AND id=?")
      .get(kind, recordId);
    return row ? (JSON.parse(row.value as string) as RecordMap[K]) : undefined;
  }
  require<K extends RecordKind>(kind: K, recordId: string): RecordMap[K] {
    const record = this.get(kind, recordId);
    if (!record)
      throw new AppError("not_found", `${kind} ${recordId} was not found.`);
    return record;
  }
  list<K extends RecordKind>(kind: K, query: RecordQuery = {}): RecordMap[K][] {
    const { where, parameters } = recordFilter(kind, query);
    const limit = query.limit ?? -1,
      offset = query.offset ?? 0;
    if (
      !Number.isInteger(limit) ||
      limit < -1 ||
      !Number.isInteger(offset) ||
      offset < 0
    )
      throw new AppError(
        "invalid_query",
        "Pagination requires nonnegative integers.",
      );
    parameters.push(limit, offset);
    return this.db
      .prepare(
        `SELECT value FROM records WHERE ${where} ORDER BY ordinal ${query.descending ? "DESC" : "ASC"} LIMIT ? OFFSET ?`,
      )
      .all(...parameters)
      .map((row) => JSON.parse(row.value as string) as RecordMap[K]);
  }
  count(kind: RecordKind, query: RecordFilter = {}): number {
    const { where, parameters } = recordFilter(kind, query);
    return Number(
      this.db
        .prepare(`SELECT COUNT(*) AS total FROM records WHERE ${where}`)
        .get(...parameters)?.total ?? 0,
    );
  }
  runHeaders(query: RecordQuery = {}): RunHeader[] {
    const { where, parameters } = recordFilter("run", query);
    return this.db
      .prepare(
        `SELECT json_object('id',id,'name',json_extract(value,'$.name'),'status',status,'retryOf',json_extract(value,'$.retryOf')) AS value FROM records WHERE ${where} ORDER BY ordinal`,
      )
      .all(...parameters)
      .map((row) => JSON.parse(String(row.value)) as RunHeader);
  }
  runState(runId: string): RunState {
    const row = this.db
      .prepare(
        "SELECT json_set(json_remove(value,'$.manifest'),'$.targetKind',COALESCE(json_extract(value,'$.manifest.target.kind'),'managed'),'$.targetHarness',COALESCE(json_extract(value,'$.manifest.target.agent.harness'),json_extract(value,'$.manifest.agent.harness')),'$.researchStatus',(SELECT parent.status FROM records parent WHERE parent.kind='research' AND parent.id=records.session_id)) AS value FROM records WHERE kind='run' AND id=?",
      )
      .get(runId);
    if (!row) throw new AppError("not_found", `run ${runId} was not found.`);
    const state = JSON.parse(String(row.value)) as RunState;
    for (const key of ["targetHarness", "researchStatus"] as const)
      if (state[key] === null) delete state[key];
    return state;
  }
  appliedAnswerSource(
    runId: string,
    resultId: string,
  ): AnswerSource | undefined {
    const row = this.db
      .prepare(
        "SELECT json_set(json_extract(item.value,'$.source'),'$.applicationId',records.id) AS value FROM records,json_each(records.value,'$.bindings') item WHERE kind='retryApplication' AND run_id=? AND json_extract(item.value,'$.resultId')=? ORDER BY records.ordinal DESC,item.key DESC LIMIT 1",
      )
      .get(runId, resultId);
    return row ? (JSON.parse(String(row.value)) as AnswerSource) : undefined;
  }
  answerSource(attemptId: string): AnswerSource {
    const row = this.db
      .prepare(
        "SELECT id,run_id,result_id,json_extract(value,'$.evidenceHash') AS hash FROM records WHERE kind='attempt' AND id=?",
      )
      .get(attemptId);
    if (!row)
      throw new AppError("not_found", `attempt ${attemptId} was not found.`);
    return {
      runId: String(row.run_id),
      resultId: String(row.result_id),
      attemptId: String(row.id),
      evidenceHash: String(row.hash ?? ""),
    };
  }
  resultAnswerSources(
    runId: string,
  ): Array<ResultRecord & { answerSource?: AnswerSource }> {
    return this.db
      .prepare(
        `SELECT r.value AS result,a.id AS attempt_id,a.run_id AS source_run_id,a.result_id AS source_result_id,json_extract(a.value,'$.evidenceHash') AS hash FROM records r LEFT JOIN records a ON a.kind='attempt' AND a.id=json_extract(r.value,'$.completedAttemptId') WHERE r.kind='result' AND r.run_id=? ORDER BY r.ordinal`,
      )
      .all(runId)
      .map((row) => ({
        ...(JSON.parse(String(row.result)) as ResultRecord),
        ...(row.attempt_id
          ? {
              answerSource: {
                runId: String(row.source_run_id),
                resultId: String(row.source_result_id),
                attemptId: String(row.attempt_id),
                evidenceHash: String(row.hash ?? ""),
              },
            }
          : {}),
      }));
  }
  runPage(query: RunListQuery = {}): {
    runs: Array<
      Pick<
        RunSummary,
        | "id"
        | "name"
        | "status"
        | "createdAt"
        | "bankId"
        | "bankName"
        | "model"
        | "harness"
        | "targetKind"
        | "targetName"
        | "researchSessionId"
        | "selectedAssessmentPassId"
      >
    >;
    total: number;
    nextOffset: number | null;
  } {
    const clauses = ["kind='run'"],
      parameters: SQLInputValue[] = [];
    if (query.bankId) {
      clauses.push("run_bank_id=?");
      parameters.push(query.bankId);
    }
    if (query.status) {
      clauses.push("status=?");
      parameters.push(query.status);
    }
    if (query.search?.trim()) {
      clauses.push(
        "instr(normalize_search(json_extract(value,'$.name') || ' ' || json_extract(value,'$.manifest.bank.name') || ' ' || COALESCE(json_extract(value,'$.manifest.target.name'),json_extract(value,'$.manifest.target.agent.harness') || ' / ' || json_extract(value,'$.manifest.target.agent.model'),json_extract(value,'$.manifest.agent.harness') || ' / ' || json_extract(value,'$.manifest.agent.model'),'')),?)>0",
      );
      parameters.push(normalizeRunSearch(query.search.trim()));
    }
    const where = clauses.join(" AND "),
      limit = query.limit ?? 100,
      offset = query.offset ?? 0;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      !Number.isInteger(offset) ||
      offset < 0
    )
      throw new AppError(
        "invalid_query",
        "Run pages require a limit from 1 to 200 and a nonnegative offset.",
      );
    const total = Number(
      this.db
        .prepare(`SELECT COUNT(*) AS total FROM records WHERE ${where}`)
        .get(...parameters)!.total,
    );
    const runs = this.db
      .prepare(
        `SELECT json_object('id',id,'name',json_extract(value,'$.name'),'status',status,'createdAt',json_extract(value,'$.createdAt'),'bankId',run_bank_id,'bankName',json_extract(value,'$.manifest.bank.name'),'model',COALESCE(json_extract(value,'$.manifest.target.agent.model'),json_extract(value,'$.manifest.agent.model')),'harness',COALESCE(json_extract(value,'$.manifest.target.agent.harness'),json_extract(value,'$.manifest.agent.harness')),'targetKind',COALESCE(json_extract(value,'$.manifest.target.kind'),'managed'),'targetName',json_extract(value,'$.manifest.target.name'),'researchSessionId',session_id,'selectedAssessmentPassId',json_extract(value,'$.selectedAssessmentPassId')) AS value FROM records WHERE ${where} ORDER BY ordinal DESC LIMIT ? OFFSET ?`,
      )
      .all(...parameters, limit, offset)
      .map((row) => {
        const value = JSON.parse(String(row.value));
        for (const key of [
          "researchSessionId",
          "selectedAssessmentPassId",
          "targetName",
        ])
          if (value[key] === null) delete value[key];
        return value;
      });
    return {
      runs,
      total,
      nextOffset: offset + runs.length < total ? offset + runs.length : null,
    };
  }
  runOutcomeCounts(
    runId: string,
  ): Pick<RunSummary, "completed" | "failed" | "total"> {
    const row = this.db
      .prepare(
        `WITH applied AS (SELECT DISTINCT json_extract(item.value,'$.resultId') AS result_id FROM records,json_each(records.value,'$.bindings') item WHERE kind='retryApplication' AND run_id=?) SELECT COUNT(*) AS total,COALESCE(SUM(json_type(value,'$.completedAttemptId')='text' OR id IN (SELECT result_id FROM applied)),0) AS completed,COALESCE(SUM(status='failed' AND json_type(value,'$.completedAttemptId') IS NULL AND id NOT IN (SELECT result_id FROM applied)),0) AS failed FROM records WHERE kind='result' AND run_id=?`,
      )
      .get(runId, runId)!;
    return {
      total: Number(row.total),
      completed: Number(row.completed),
      failed: Number(row.failed),
    };
  }
  assessmentPassSummaries(runId: string): AssessmentPassSummary[] {
    return this.db
      .prepare(
        "SELECT json_remove(value,'$.configuration','$.judgments','$.basis.eligibleResultIds','$.basis.excludedResultIds') AS value FROM records WHERE kind='assessmentPass' AND run_id=? ORDER BY ordinal",
      )
      .all(runId)
      .map((row) => JSON.parse(String(row.value)) as AssessmentPassSummary);
  }
  /** Logical bindings and raw automatic judgments, without evidence or configuration bodies. */
  automaticAssessmentInputs(
    runId: string,
    first: boolean,
    scoreSetId?: string,
  ): AutomaticAssessmentInput[] {
    const compact = (value: string) =>
      `json_remove(${value},'$.deterministic.details','$.judgeRequest','$.judgeResponse','$.judge.custom')`;
    const physical = `(SELECT json_object('recordId',a.id,'assessment',json(${compact("a.value")}), 'judgeResponded',json_type(a.value,'$.judge') IS NOT NULL OR json_type(a.value,'$.judgeResponse') IS NOT NULL) FROM records a WHERE a.kind='assessment' AND a.run_id=json_extract(b.answer,'$.runId') AND a.result_id=json_extract(b.answer,'$.resultId') AND json_extract(a.value,'$.attemptId')=b.attempt_id ORDER BY a.ordinal LIMIT 1)`;
    const legacy = `(SELECT json_object('scoreSetId',s.id,'assessment',json(${compact("item.value")}), 'judgeResponded',json_type(item.value,'$.judge') IS NOT NULL OR json_type(item.value,'$.judgeResponse') IS NOT NULL) FROM records s,json_each(s.value,'$.assessments') item WHERE s.kind='scoreSet' AND s.run_id=json_extract(b.answer,'$.runId') AND json_extract(s.value,'$.kind')='original' AND json_extract(item.value,'$.resultId')=json_extract(b.answer,'$.resultId') AND json_extract(item.value,'$.attemptId')=b.attempt_id ORDER BY s.ordinal,CAST(item.key AS INTEGER) LIMIT 1)`;
    const captured = `(SELECT json_object('scoreSetId',original.id,'assessment',json(${compact("item.value")}), 'judgeResponded',json_type(item.value,'$.judge') IS NOT NULL OR json_type(item.value,'$.judgeResponse') IS NOT NULL) FROM original,json_each(original.value,'$.assessments') item WHERE json_extract(item.value,'$.resultId')=json_extract(b.result,'$.id') AND json_extract(item.value,'$.attemptId')=b.attempt_id LIMIT 1)`;
    const tree = (manifest: string) =>
      `SELECT fullkey,CASE WHEN type IN ('integer','real') THEN 'number' ELSE type END AS type,atom FROM json_tree(${manifest})`;
    const sameManifest = `NOT EXISTS (${tree("json_extract(b.source_run,'$.manifest')")} EXCEPT ${tree("json_extract(r.value,'$.manifest')")}) AND NOT EXISTS (${tree("json_extract(r.value,'$.manifest')")} EXCEPT ${tree("json_extract(b.source_run,'$.manifest')")})`;
    return this.db
      .prepare(
        `
      WITH original AS (
        SELECT id,value FROM records WHERE kind='scoreSet' AND run_id=?1 AND ((?3 IS NULL AND json_extract(value,'$.kind')='original') OR id=?3) ORDER BY ordinal LIMIT 1
      ), applied AS (
        SELECT json_extract(item.value,'$.resultId') AS result_id,json_extract(item.value,'$.source') AS source,
          ROW_NUMBER() OVER (PARTITION BY json_extract(item.value,'$.resultId') ORDER BY app.ordinal DESC,CAST(item.key AS INTEGER) DESC) AS rank
        FROM records app,json_each(app.value,'$.bindings') item WHERE app.kind='retryApplication' AND app.run_id=?1
      ), selected AS MATERIALIZED (
        SELECT r.value AS result,r.ordinal,
          CASE WHEN ?2 THEN CASE WHEN EXISTS(SELECT 1 FROM original)
            THEN (SELECT json_extract(item.value,'$.attemptId') FROM original,json_each(original.value,'$.assessments') item WHERE json_extract(item.value,'$.resultId')=r.id LIMIT 1)
            ELSE (SELECT a.id FROM json_each(r.value,'$.attemptIds') item CROSS JOIN records a ON a.kind='attempt' AND a.id=item.value WHERE a.status='completed' AND COALESCE(json_extract(a.value,'$.executionId'),?1)=?1 ORDER BY CAST(item.key AS INTEGER) DESC LIMIT 1) END
            ELSE COALESCE(json_extract(applied.source,'$.attemptId'),json_extract(r.value,'$.completedAttemptId')) END AS attempt_id,
          CASE WHEN NOT ?2 THEN applied.source END AS applied_source
        FROM records r LEFT JOIN applied ON applied.result_id=r.id AND applied.rank=1 WHERE r.kind='result' AND r.run_id=?1
      ), bound AS (
        SELECT s.*,a.value AS attempt,owner.value AS owner,sr.value AS source_run,
          CASE WHEN s.attempt_id IS NOT NULL THEN COALESCE(s.applied_source,json_object('runId',a.run_id,'resultId',a.result_id,'attemptId',s.attempt_id,'evidenceHash',json_extract(a.value,'$.evidenceHash'))) END AS answer
        FROM selected s LEFT JOIN records a ON a.kind='attempt' AND a.id=s.attempt_id
        LEFT JOIN records owner ON owner.kind='result' AND owner.id=COALESCE(json_extract(s.applied_source,'$.resultId'),a.result_id)
        LEFT JOIN records sr ON sr.kind='run' AND sr.id=COALESCE(json_extract(s.applied_source,'$.runId'),a.run_id)
      )
      SELECT json_object('result',json(b.result),'attemptId',b.attempt_id,'source',json(b.answer),
        'attempt',CASE WHEN b.attempt IS NOT NULL THEN json_object('runId',json_extract(b.attempt,'$.runId'),'resultId',json_extract(b.attempt,'$.resultId'),'status',json_extract(b.attempt,'$.status'),'finishedAt',json_extract(b.attempt,'$.finishedAt'),'evidenceHash',json_extract(b.attempt,'$.evidenceHash'),'hasOutput',json_type(b.attempt,'$.output')='object') END,
        'owner',CASE WHEN b.owner IS NOT NULL THEN json_object('runId',json_extract(b.owner,'$.runId'),'questionId',json_extract(b.owner,'$.questionId'),'repetition',json_extract(b.owner,'$.repetition')) END,
        'sourceRun',CASE WHEN b.source_run IS NOT NULL THEN json_object('id',json_extract(b.source_run,'$.id'),'retryOf',json_extract(b.source_run,'$.retryOf'),'sameManifest',CASE WHEN json_extract(b.source_run,'$.id')=?1 THEN 1 ELSE (${sameManifest}) END) END,
        'raw',json(COALESCE(${first ? `${captured},${legacy},${physical}` : `${physical},${legacy}`})),
        'jev',json((SELECT json_object('id',j.id,'status',j.status,'checks',json_extract(j.value,'$.checks'),'criteria',json_object('confidenceThreshold',json_extract(j.value,'$.criteria.confidenceThreshold')),'error',CASE WHEN json_type(j.value,'$.error')='object' THEN json_object('message',json_extract(j.value,'$.error.message')) END,'usage',json_extract(j.value,'$.usage')) FROM records j WHERE j.kind='jevAssessment' AND j.run_id=json_extract(b.answer,'$.runId') AND j.result_id=json_extract(b.answer,'$.resultId') AND json_extract(j.value,'$.attemptId')=b.attempt_id AND json_extract(j.value,'$.attemptEvidenceHash')=json_extract(b.answer,'$.evidenceHash') AND json_extract(j.value,'$.kind')='original' ORDER BY j.ordinal LIMIT 1))
      ) AS value FROM bound b JOIN records r ON r.kind='run' AND r.id=?1 ORDER BY b.ordinal
    `,
      )
      .all(runId, first ? 1 : 0, scoreSetId ?? null)
      .map((row) => {
        const input = JSON.parse(String(row.value));
        for (const key of [
          "attemptId",
          "source",
          "attempt",
          "owner",
          "sourceRun",
          "raw",
          "jev",
        ])
          if (input[key] === null) delete input[key];
        if (input.attempt)
          input.attempt.hasOutput = input.attempt.hasOutput === 1;
        if (input.sourceRun)
          input.sourceRun.sameManifest = input.sourceRun.sameManifest === 1;
        if (input.raw)
          input.raw.judgeResponded = input.raw.judgeResponded === 1;
        if (input.jev)
          for (const key of ["checks", "error", "usage"])
            if (input.jev[key] === null) delete input.jev[key];
        return input as AutomaticAssessmentInput;
      });
  }
  legacyAssessmentInputs(runId: string): Array<
    Omit<ScoreSummaryInput, "assessments"> & {
      inputs: AutomaticAssessmentInput[];
    }
  > {
    return this.legacyScoreSummaryInputs(runId).map(
      ({ assessments: _assessments, ...seed }) => ({
        ...seed,
        inputs: this.automaticAssessmentInputs(
          runId,
          true,
          seed.id.slice("scores_".length),
        ),
      }),
    );
  }
  runAssessmentState(runId: string): Pick<
    RunRecord,
    "createdAt" | "updatedAt" | "status" | "execution"
  > & {
    judgeEnabled: boolean;
    jevEnabled: boolean;
  } {
    const row = this.db
      .prepare(
        "SELECT json_object('createdAt',json_extract(value,'$.createdAt'),'updatedAt',json_extract(value,'$.updatedAt'),'status',status,'execution',json_extract(value,'$.execution'),'judgeEnabled',json_extract(value,'$.manifest.judge.enabled'),'jevEnabled',json_type(value,'$.manifest.jevJudge')='object') AS value FROM records WHERE kind='run' AND id=?",
      )
      .get(runId);
    if (!row) throw new AppError("not_found", `run ${runId} was not found.`);
    return JSON.parse(String(row.value));
  }
  runAssessmentBasis(runId: string): {
    createdAt: string;
    updatedAt: string;
    status: RunRecord["status"];
    judgeEnabled: boolean;
    jevEnabled: boolean;
    basis: PassSummaryBasis;
  } {
    const row = this.db
      .prepare(
        `SELECT json_object('createdAt',json_extract(value,'$.createdAt'),'updatedAt',json_extract(value,'$.updatedAt'),'status',status,'judgeEnabled',json_extract(value,'$.manifest.judge.enabled'),'jevEnabled',json_type(value,'$.manifest.jevJudge')='object','basis',json_patch(${comparisonDisposition("json_extract(records.value,'$.manifest.evaluator.settings')")},json_object('bankRevisionId',json_extract(value,'$.manifest.bank.id'),'evaluatorRevisionId',json_extract(value,'$.manifest.evaluator.id'),'referenceHash',${referenceHash("json_extract(records.value,'$.manifest.questions')", "json_extract(records.value,'$.manifest.questions')")}))) AS value FROM records WHERE kind='run' AND id=?`,
      )
      .get(runId);
    if (!row) throw new AppError("not_found", `run ${runId} was not found.`);
    return JSON.parse(String(row.value));
  }
  legacyScoreSummaryInputs(runId: string): ScoreSummaryInput[] {
    return this.db
      .prepare(
        `SELECT json_object('id','scores_' || scores.id,'name',json_extract(scores.value,'$.evaluator.name') || ' (revision ' || json_extract(scores.value,'$.evaluator.number') || ')' || CASE WHEN json_extract(scores.value,'$.published')=1 THEN '' ELSE ' (unpublished historical score)' END,'createdAt',json_extract(scores.value,'$.createdAt'),'basis',json_patch(${comparisonDisposition("json_extract(scores.value,'$.evaluator.settings')")},json_object('bankRevisionId',COALESCE(json_extract(scores.value,'$.referenceBank.id'),json_extract(run.value,'$.manifest.bank.id')),'evaluatorRevisionId',json_extract(scores.value,'$.evaluator.id'),'referenceHash',${referenceHash("COALESCE(json_extract(scores.value,'$.referenceBank.questions'),json_extract(run.value,'$.manifest.questions'))", "json_extract(run.value,'$.manifest.questions')")})),'assessments',json(COALESCE((SELECT json_group_array(json(${compactAssessment("item.value")})) FROM json_each(scores.value,'$.assessments') item),'[]'))) AS value FROM records scores JOIN records run ON run.kind='run' AND run.id=scores.run_id WHERE scores.kind='scoreSet' AND scores.run_id=? AND json_extract(scores.value,'$.kind')!='original' AND NOT EXISTS(SELECT 1 FROM records pass WHERE pass.kind='assessmentPass' AND pass.id='scores_' || scores.id) ORDER BY scores.ordinal`,
      )
      .all(runId)
      .map((row) => JSON.parse(String(row.value)));
  }
  assessmentPassObservations(runId: string): AssessmentPass[] {
    return this.db
      .prepare(
        `SELECT json_set(json_remove(value,'$.configuration'),'$.configuration',json('{}'),'$.judgments',json(COALESCE((SELECT json_group_array(json_remove(item.value,'$.request','$.response','$.details')) FROM json_each(records.value,'$.judgments') item),'[]'))) AS value FROM records WHERE kind='assessmentPass' AND run_id=? ORDER BY ordinal`,
      )
      .all(runId)
      .map((row) => JSON.parse(row.value as string) as AssessmentPass);
  }
  eventCounts(runId: string, attemptIds?: string[]): Record<string, number> {
    return Object.fromEntries(
      this.db
        .prepare(
          "SELECT type, COUNT(*) AS total FROM events WHERE run_id=? AND (? IS NULL OR attempt_id IN (SELECT value FROM json_each(?))) GROUP BY type",
        )
        .all(
          runId,
          attemptIds ? JSON.stringify(attemptIds) : null,
          attemptIds ? JSON.stringify(attemptIds) : null,
        )
        .map((row) => [String(row.type), Number(row.total)]),
    );
  }
  attemptUsageEvents(attemptId: string): Json[] | undefined {
    const size = this.db
      .prepare(
        "SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(data AS BLOB))),0) AS bytes FROM events WHERE attempt_id=? AND type='usage'",
      )
      .get(attemptId)!;
    if (Number(size.count) > 4096 || Number(size.bytes) > 1048576)
      return undefined;
    return this.db
      .prepare(
        "SELECT data FROM events WHERE attempt_id=? AND type='usage' ORDER BY sequence",
      )
      .all(attemptId)
      .map((row) => (row.data ? (JSON.parse(String(row.data)) as Json) : null));
  }
  attemptSummaries(runId: string): AttemptSummary[] {
    return this.db
      .prepare(
        `SELECT json_remove(value,'$.output','$.adapterCheckpoint','$.failure.transport') AS metadata,
      COALESCE(json_extract(value,'$.output.usage'),json_extract(value,'$.failure.classification.usage')) AS usage,
      json_type(value,'$.output') IS NOT NULL AS has_output
      FROM records WHERE kind='attempt' AND run_id=? ORDER BY ordinal`,
      )
      .all(runId)
      .map((row) => ({
        ...(JSON.parse(row.metadata as string) as Omit<
          AttemptRecord,
          "output"
        >),
        hasOutput: row.has_output === 1,
        ...(row.usage
          ? {
              usage: JSON.parse(row.usage as string) as AttemptSummary["usage"],
            }
          : {}),
      }));
  }
  attemptAssessments(
    runId: string,
    attemptId: string,
  ): AttemptDetail["assessments"] {
    return this.db
      .prepare(
        `SELECT records.id AS score_set_id,json_extract(records.value,'$.evaluator') AS evaluator,item.value AS assessment
      FROM records JOIN json_each(records.value,'$.assessments') item WHERE records.kind='scoreSet' AND records.run_id=? AND json_extract(item.value,'$.attemptId')=? ORDER BY records.ordinal`,
      )
      .all(runId, attemptId)
      .map((row) => ({
        scoreSetId: row.score_set_id as string,
        evaluator: JSON.parse(row.evaluator as string) as EvaluatorRevision,
        assessment: JSON.parse(row.assessment as string) as Assessment,
      }));
  }
  judgeRequest(attemptId: string): Json | undefined {
    const row = this.db
      .prepare(
        "SELECT data FROM events WHERE attempt_id=? AND type='judge.request' ORDER BY sequence DESC LIMIT 1",
      )
      .get(attemptId);
    return row?.data ? (JSON.parse(row.data as string) as Json) : undefined;
  }
  originalJudgeUsage(runId: string, attemptIds?: string[]): UsageReport[] {
    return this.db
      .prepare(
        `SELECT COALESCE(json_extract(value,'$.judgeUsage'),json_extract(value,'$.judge.usage')) AS usage,0 AS pending FROM records WHERE kind='assessment' AND json_extract(value,'$.judgeAdmitted') IS NOT 0 AND run_id=? AND (? IS NULL OR json_extract(value,'$.attemptId') IN (SELECT value FROM json_each(?))) AND (json_type(value,'$.judge') IS NOT NULL OR json_type(value,'$.judgeError') IS NOT NULL)
    UNION ALL SELECT NULL AS usage,1 AS pending FROM events WHERE run_id=? AND (? IS NULL OR attempt_id IN (SELECT value FROM json_each(?))) AND type='judge.request' AND NOT EXISTS(SELECT 1 FROM records WHERE kind='assessment' AND run_id=events.run_id AND json_extract(value,'$.attemptId')=events.attempt_id) GROUP BY attempt_id`,
      )
      .all(
        runId,
        attemptIds ? JSON.stringify(attemptIds) : null,
        attemptIds ? JSON.stringify(attemptIds) : null,
        runId,
        attemptIds ? JSON.stringify(attemptIds) : null,
        attemptIds ? JSON.stringify(attemptIds) : null,
      )
      .map((row) => ({
        ...(row.usage
          ? { usage: JSON.parse(row.usage as string) as UsageReport["usage"] }
          : {}),
        pending: row.pending === 1,
      }));
  }
  passJudgeUsage(runId: string): Array<UsageReport & { judgmentId: string }> {
    return this.db
      .prepare(
        `SELECT json_extract(item.value,'$.judgmentId') AS judgment_id,json_extract(item.value,'$.usage') AS usage,json_extract(records.value,'$.status')='running' AND json_extract(item.value,'$.status')='unjudged' AND json_type(item.value,'$.response') IS NULL AS pending FROM records,json_each(records.value,'$.judgments') item WHERE records.kind='assessmentPass' AND records.run_id=? AND json_extract(records.value,'$.source')='llm' AND json_type(item.value,'$.judgmentId')='text'`,
      )
      .all(runId)
      .map((row) => ({
        judgmentId: String(row.judgment_id),
        ...(row.usage
          ? { usage: JSON.parse(row.usage as string) as UsageReport["usage"] }
          : {}),
        pending: row.pending === 1,
      }));
  }
  researchUsage(sessionId: string): {
    currentRunId: string;
    pending: boolean;
    interruptedTurns: number;
    turns: Array<{
      runId: string | null;
      usage?: UsageReport["usage"];
      usageScope?: string;
    }>;
  } {
    const record = this.db
      .prepare(
        "SELECT json_extract(value,'$.currentRunId') AS current_run_id,json_type(value,'$.pendingTurn') IS NOT NULL AS pending,COALESCE(json_extract(value,'$.interruptedTurns'),0) AS interrupted FROM records WHERE kind='research' AND id=?",
      )
      .get(sessionId);
    if (!record)
      throw new AppError("not_found", "The research session does not exist.");
    const turns = this.db
      .prepare(
        `SELECT CASE WHEN json_valid(json_extract(item.value,'$.input')) THEN COALESCE(json_extract(json_extract(item.value,'$.input'),'$.completedRun.runId'),json_extract(json_extract(item.value,'$.input'),'$.baselineRun.runId'),json_extract(json_extract(item.value,'$.input'),'$.runId')) ELSE NULL END AS run_id,json_extract(item.value,'$.output.usage') AS usage,json_extract(item.value,'$.output.usageScope') AS scope FROM records,json_each(records.value,'$.turns') item WHERE records.kind='research' AND records.id=?`,
      )
      .all(sessionId)
      .map((row) => ({
        runId: row.run_id as string | null,
        ...(row.usage
          ? {
              usage: JSON.parse(row.usage as string) as {
                inputTokens?: number;
                cachedInputTokens?: number;
                outputTokens?: number;
                costUsd?: number;
              },
            }
          : {}),
        ...(row.scope ? { usageScope: String(row.scope) } : {}),
      }));
    return {
      currentRunId: String(record.current_run_id),
      pending: record.pending === 1,
      interruptedTurns: Number(record.interrupted),
      turns,
    };
  }
  researchSummary(sessionId: string): ResearchSummary {
    const row = this.db
      .prepare(
        `SELECT json_remove(value,'$.turns','$.pendingTurn','$.pendingProposal') AS metadata,
      (SELECT json_group_array(json_object('createdAt',json_extract(item.value,'$.createdAt'),'output',json_object(
        'conversationId',json_extract(item.value,'$.output.conversationId'),
        'message',substr(json_extract(item.value,'$.output.message'),1,1000),
        'decision',json_extract(item.value,'$.output.decision'),
        'disposition',json_extract(item.value,'$.output.disposition'),
        'control',json_extract(item.value,'$.output.control'),
        'stopCategory',json_extract(item.value,'$.output.stopCategory'),
        'reason',substr(json_extract(item.value,'$.output.reason'),1,1000),
        'usage',json(json_extract(item.value,'$.output.usage')),
        'usageScope',json_extract(item.value,'$.output.usageScope')))) FROM json_each(records.value,'$.turns') item) AS turns
      FROM records WHERE kind='research' AND id=?`,
      )
      .get(sessionId);
    if (!row)
      throw new AppError("not_found", `Research ${sessionId} was not found.`);
    const turns = JSON.parse(row.turns as string) as ResearchSummary["turns"];
    for (const turn of turns)
      for (const [key, value] of Object.entries(turn.output))
        if (value === null)
          delete (turn.output as unknown as Record<string, unknown>)[key];
    return {
      ...(JSON.parse(row.metadata as string) as Omit<ResearchSummary, "turns">),
      turns,
    };
  }
  delete(kind: "blueprint" | "evaluatorDraft", recordId: string): void {
    const result = this.db
      .prepare("DELETE FROM records WHERE kind=? AND id=? AND immutable=0")
      .run(kind, recordId);
    if (result.changes !== 1)
      throw new AppError(
        "immutable_or_missing",
        `Cannot delete ${kind} ${recordId}.`,
      );
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  append(event: {
    runId?: string;
    sessionId?: string;
    attemptId?: string;
    type: string;
    message: string;
    data?: Json;
  }): ObservationEvent {
    const createdAt = now();
    const result = this.db
      .prepare(
        "INSERT INTO events(run_id,session_id,attempt_id,created_at,type,message,data) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        event.runId ?? null,
        event.sessionId ?? null,
        event.attemptId ?? null,
        createdAt,
        event.type,
        event.message,
        event.data === undefined ? null : JSON.stringify(event.data),
      );
    return { ...event, createdAt, sequence: Number(result.lastInsertRowid) };
  }
  controlSequence(scope: { runId: string } | { sessionId: string }): number {
    const [column, ownerId, eventType] =
      "runId" in scope
        ? ["run_id", scope.runId, "run.control.requested"]
        : ["session_id", scope.sessionId, "research.control.requested"];
    const row = this.db
      .prepare(
        `SELECT sequence FROM events WHERE ${column}=? AND type='${eventType}' ORDER BY sequence DESC LIMIT 1`,
      )
      .get(ownerId);
    return Number(row?.sequence ?? 0);
  }
  events(
    scope: { runId?: string; sessionId?: string; attemptId?: string },
    cursor = 0,
    options: { limit?: number; summary?: boolean } = {},
  ): ObservationEvent[] {
    const limit = options.limit ?? 5000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000)
      throw new AppError(
        "invalid_query",
        "Event pages require a limit from 1 to 5,000.",
      );
    const clauses = ["sequence>?"];
    const parameters: SQLInputValue[] = [cursor];
    for (const [key, column] of Object.entries({
      runId: "run_id",
      sessionId: "session_id",
      attemptId: "attempt_id",
    })) {
      const value = scope[key as keyof typeof scope];
      if (value === undefined) continue;
      clauses.push(`${column}=?`);
      parameters.push(value);
    }
    if (clauses.length === 1) return [];
    const projection = options.summary
      ? "sequence,created_at,type,substr(message,1,1000) AS message,run_id,session_id,attempt_id,NULL AS data"
      : "*";
    return this.db
      .prepare(
        `SELECT ${projection} FROM events WHERE ${clauses.join(" AND ")} ORDER BY sequence LIMIT ?`,
      )
      .all(...parameters, limit)
      .map((row) => ({
        sequence: Number(row.sequence),
        createdAt: row.created_at as string,
        type: row.type as string,
        message: row.message as string,
        ...(row.run_id ? { runId: row.run_id as string } : {}),
        ...(row.session_id ? { sessionId: row.session_id as string } : {}),
        ...(row.attempt_id ? { attemptId: row.attempt_id as string } : {}),
        ...(row.data ? { data: JSON.parse(row.data as string) as Json } : {}),
      }));
  }
  idempotent(
    key: string,
    hash: string,
  ): { kind: string; id: string; response?: Json } | undefined {
    const row = this.db
      .prepare("SELECT * FROM idempotency WHERE key=?")
      .get(key);
    if (!row) return undefined;
    if (row.hash !== hash)
      throw new AppError(
        "idempotency_conflict",
        "This idempotency key was already used with different input.",
      );
    return {
      kind: row.kind as string,
      id: row.record_id as string,
      ...(row.response
        ? { response: JSON.parse(String(row.response)) as Json }
        : {}),
    };
  }
  remember(
    key: string,
    hash: string,
    kind: RecordKind,
    recordId: string,
    response?: Json,
  ): void {
    this.db
      .prepare(
        "INSERT INTO idempotency(key,hash,kind,record_id,response) VALUES (?,?,?,?,?)",
      )
      .run(
        key,
        hash,
        kind,
        recordId,
        response === undefined ? null : canonical(response),
      );
  }
  close(): void {
    this.db.close();
  }
}
