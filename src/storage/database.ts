import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  Assessment,
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
  ScoreSetSummary,
  AssessmentSummary,
  ResearchSummary,
  AttemptDetail,
  JevProfileRevision,
  JevAssessmentRecord,
  JevAssessmentSummary,
} from "../contracts.js";
import { AppError } from "../domain/errors.js";
import { canonical, now } from "../domain/identity.js";

export interface RecordMap {
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
  runId?: string | string[];
  resultId?: string;
  bankId?: string;
  researchSessionId?: string;
  status?: string | string[];
  limit?: number;
  offset?: number;
  descending?: boolean;
}
const policies: Record<RecordKind, { appendOnly: boolean; fixed: string[] }> = {
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
    fixed: ["runId", "resultId", "number", "startedAt"],
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
const queryColumns = {
  runId: "run_id",
  resultId: "result_id",
  bankId: "bank_id",
  researchSessionId: "session_id",
  status: "status",
} as const;

function assessmentProjection(value: string): string {
  const base = `json_set(json_remove(${value},'$.deterministic.details','$.judge.custom','$.judge.usage'),'$.deterministic.explanation',substr(json_extract(${value},'$.deterministic.explanation'),1,300))`;
  const judge = `CASE WHEN json_type(${value},'$.judge.explanation')='text' THEN json_set(${base},'$.judge.explanation',substr(json_extract(${value},'$.judge.explanation'),1,300)) ELSE ${base} END`;
  return `CASE WHEN json_type(${value},'$.judgeError')='text' THEN json_set(${judge},'$.judgeError',substr(json_extract(${value},'$.judgeError'),1,300)) ELSE ${judge} END`;
}
type RecordFilter = Omit<RecordQuery, "limit" | "offset" | "descending">;
function recordFilter(
  kind: RecordKind,
  query: RecordFilter,
): { where: string; parameters: SQLInputValue[] } {
  const clauses = ["kind=?"];
  const parameters: SQLInputValue[] = [kind];
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
    try {
      const version = Number(
        this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0,
      );
      if (version > 3)
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
      CREATE TABLE IF NOT EXISTS ${version === 1 ? "records_v2" : "records"} (
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
    if (version === 1)
      this.db.exec(`
      INSERT INTO records_v2(kind,id,value,immutable,ordinal) SELECT kind,id,value,immutable,ordinal FROM records;
      DROP TABLE records;
      ALTER TABLE records_v2 RENAME TO records;
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
      CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, hash TEXT NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL,
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
    this.db.exec("PRAGMA user_version=3; COMMIT; PRAGMA foreign_keys=ON;");
  }
  jevSummaries(runId: string): JevAssessmentSummary[] {
    return this.db
      .prepare(
        `SELECT json_set(json_remove(value,'$.evidence','$.criteria','$.request','$.response','$.attempts','$.configuration','$.configurationHash','$.evidenceHash','$.attemptEvidenceHash','$.bankRevisionId','$.evaluatorRevisionId','$.httpStatus','$.requestId'),
      '$.profileRevisionId',json_extract(value,'$.configuration.profile.id'),
      '$.profileRevisionNumber',json_extract(value,'$.configuration.profile.number'),
      '$.profileName',json_extract(value,'$.configuration.profile.name'),
      '$.confidenceThreshold',json_extract(value,'$.criteria.confidenceThreshold')) AS summary
      FROM records WHERE kind='jevAssessment' AND run_id=? ORDER BY ordinal`,
      )
      .all(runId)
      .map((row) => JSON.parse(row.summary as string) as JevAssessmentSummary);
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
  attemptSummaries(runId: string): AttemptSummary[] {
    return this.db
      .prepare(
        `SELECT json_remove(value,'$.output','$.adapterCheckpoint','$.failure.transport') AS metadata,
      json_extract(value,'$.output.usage') AS usage,
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
  assessmentSummaries(runId: string): AssessmentSummary[] {
    return this.db
      .prepare(
        `SELECT ${assessmentProjection("value")} AS summary FROM records WHERE kind='assessment' AND run_id=? ORDER BY ordinal`,
      )
      .all(runId)
      .map((row) => JSON.parse(row.summary as string) as AssessmentSummary);
  }
  scoreSetSummaries(runId: string): ScoreSetSummary[] {
    return this.db
      .prepare(
        `SELECT json_remove(value,'$.assessments','$.evaluator.settings','$.evaluator.calibration.results','$.referenceBank.questions') AS metadata,
      (SELECT json_group_array(json(${assessmentProjection("item.value")})) FROM json_each(records.value,'$.assessments') item) AS assessments
      FROM records WHERE kind='scoreSet' AND run_id=? ORDER BY ordinal`,
      )
      .all(runId)
      .map((row) => ({
        ...(JSON.parse(row.metadata as string) as Omit<
          ScoreSetSummary,
          "assessments"
        >),
        assessments: JSON.parse(
          row.assessments as string,
        ) as AssessmentSummary[],
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
  researchSummary(sessionId: string): ResearchSummary {
    const row = this.db
      .prepare(
        `SELECT json_remove(value,'$.turns','$.pendingTurn','$.pendingProposal') AS metadata,
      (SELECT json_group_array(json_object('createdAt',json_extract(item.value,'$.createdAt'),'output',json_object(
        'conversationId',json_extract(item.value,'$.output.conversationId'),
        'message',substr(json_extract(item.value,'$.output.message'),1,1000),
        'decision',json_extract(item.value,'$.output.decision'),
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
  ): { kind: string; id: string } | undefined {
    const row = this.db
      .prepare("SELECT * FROM idempotency WHERE key=?")
      .get(key);
    if (!row) return undefined;
    if (row.hash !== hash)
      throw new AppError(
        "idempotency_conflict",
        "This idempotency key was already used with different input.",
      );
    return { kind: row.kind as string, id: row.record_id as string };
  }
  remember(
    key: string,
    hash: string,
    kind: RecordKind,
    recordId: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO idempotency(key,hash,kind,record_id) VALUES (?,?,?,?)",
      )
      .run(key, hash, kind, recordId);
  }
  close(): void {
    this.db.close();
  }
}
