import { createHash } from "node:crypto";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";

export type DomainDocument = { id: string; managerSessionId: string };
export type WorkItemDocument = { domain: string; id: string; path: string; status: string; lifecycleStates: string[] };
export type EvidenceDocument = { type: string; status: string; path?: string };
export type DefectDocument = {
  id: string;
  report: { reporter: string; source: string; sourceDomain: string; symptom: string; impact: string; environment: string; reproduction: string; evidenceReferences: string[] };
  coordinatorDomain: string;
  workItems: WorkItemDocument[];
  evidence: EvidenceDocument[];
};
export type MigrationMetadataDocument = { source: { version: number; capturedAt: string } };
export type CanonicalSnapshot = MigrationMetadataDocument & { domains: DomainDocument[]; defects: DefectDocument[] };
export type AuditReceiptDocument = { sourceHash: string; sourceVersion: number; importedAt: string };
export type ImportResult = { imported: boolean; receipt: AuditReceiptDocument };
export type CanonicalState = { domains: DomainDocument[]; defects: DefectDocument[]; audit: AuditReceiptDocument[] };

type Database = Awaited<ReturnType<typeof openNodeSqliteDatabase>>;
type Executor = { exec(sql: string): Promise<void>; run(sql: string, ...params: (string | number | null)[]): Promise<void>; get<T extends object>(sql: string, ...params: (string | number | null)[]): Promise<T | undefined>; all<T extends object>(sql: string, ...params: (string | number | null)[]): Promise<T[]> };
type Task = { id: "rebuild-status"; replay: "safe" };
type StoredTask = { id: string };

const schema = `
  CREATE TABLE IF NOT EXISTS ttr_document (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (kind, id)
  );
  CREATE TABLE IF NOT EXISTS ttr_import (
    source_hash TEXT PRIMARY KEY,
    receipt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ttr_maintenance_task (
    id TEXT PRIMARY KEY,
    replay TEXT NOT NULL CHECK (replay = 'safe'),
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed'))
  );
`;

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
const sourceHash = (snapshot: CanonicalSnapshot) => createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
const parse = <T>(value: string): T => JSON.parse(value) as T;
const unsupported = (): never => { throw new Error("Live intake, routing, and external effects are not available in the durable TTR foundation"); };

function requireRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
}
function requireString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
}
function requireStrings(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) throw new TypeError(`${label} must be an array of non-empty strings`);
}
function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`duplicate ${label}`);
}
function validateSnapshot(snapshot: unknown): asserts snapshot is CanonicalSnapshot {
  requireRecord(snapshot, "snapshot");
  requireRecord(snapshot.source, "snapshot.source");
  if (!Number.isSafeInteger(snapshot.source.version) || (snapshot.source.version as number) < 1) throw new TypeError("snapshot.source.version must be a positive integer");
  requireString(snapshot.source.capturedAt, "snapshot.source.capturedAt");
  if (!Array.isArray(snapshot.domains) || !Array.isArray(snapshot.defects)) throw new TypeError("snapshot domains and defects must be arrays");
  for (const domain of snapshot.domains) { requireRecord(domain, "domain"); requireString(domain.id, "domain.id"); requireString(domain.managerSessionId, "domain.managerSessionId"); }
  unique(snapshot.domains.map(domain => domain.id), "domain");
  for (const defect of snapshot.defects) {
    requireRecord(defect, "defect"); requireString(defect.id, "defect.id"); requireString(defect.coordinatorDomain, "defect.coordinatorDomain"); requireRecord(defect.report, "defect.report");
    for (const key of ["reporter", "source", "sourceDomain", "symptom", "impact", "environment", "reproduction"]) requireString(defect.report[key], `defect.report.${key}`);
    requireStrings(defect.report.evidenceReferences, "defect.report.evidenceReferences");
    if (!Array.isArray(defect.workItems) || !Array.isArray(defect.evidence)) throw new TypeError("defect workItems and evidence must be arrays");
    for (const item of defect.workItems) { requireRecord(item, "work item"); for (const key of ["domain", "id", "path", "status"]) requireString(item[key], `work item.${key}`); requireStrings(item.lifecycleStates, "work item.lifecycleStates"); }
    unique(defect.workItems.map(item => item.domain), "work-item domain");
    for (const evidence of defect.evidence) { requireRecord(evidence, "evidence"); requireString(evidence.type, "evidence.type"); requireString(evidence.status, "evidence.status"); if (evidence.path !== undefined) requireString(evidence.path, "evidence.path"); }
  }
  unique(snapshot.defects.map(defect => defect.id), "defect");
}

async function open(databasePath: string, initialize: boolean): Promise<Database> {
  const database = await openNodeSqliteDatabase(databasePath);
  if (initialize) await database.exec(schema);
  return database;
}

export async function importCanonicalSnapshot(databasePath: string, snapshot: CanonicalSnapshot): Promise<ImportResult> {
  validateSnapshot(snapshot);
  const hash = sourceHash(snapshot);
  const database = await open(databasePath, true);
  try {
    return await database.transaction(async transaction => {
      const existing = await transaction.get<{ receipt: string }>("SELECT receipt FROM ttr_import WHERE source_hash = ?", hash);
      if (existing) return { imported: false, receipt: parse<AuditReceiptDocument>(existing.receipt) };
      const receipt: AuditReceiptDocument = { sourceHash: hash, sourceVersion: snapshot.source.version, importedAt: new Date().toISOString() };
      await transaction.run("INSERT INTO ttr_import (source_hash, receipt) VALUES (?, ?)", hash, JSON.stringify(receipt));
      await transaction.run("INSERT INTO ttr_document (kind, id, body) VALUES (?, ?, ?)", "migration-metadata", hash, JSON.stringify(snapshot.source));
      await transaction.run("INSERT INTO ttr_document (kind, id, body) VALUES (?, ?, ?)", "audit-receipt", hash, JSON.stringify(receipt));
      for (const domain of snapshot.domains) await transaction.run("INSERT INTO ttr_document (kind, id, body) VALUES (?, ?, ?)", "domain", domain.id, JSON.stringify(domain));
      for (const defect of snapshot.defects) {
        await transaction.run("INSERT INTO ttr_document (kind, id, body) VALUES (?, ?, ?)", "defect", defect.id, JSON.stringify(defect));
        for (const item of defect.workItems) await transaction.run("INSERT INTO ttr_document (kind, id, body) VALUES (?, ?, ?)", "work-item", `${defect.id}:${item.domain}`, JSON.stringify(item));
        for (const [index, evidence] of defect.evidence.entries()) await transaction.run("INSERT INTO ttr_document (kind, id, body) VALUES (?, ?, ?)", "evidence", `${defect.id}:${index}`, JSON.stringify(evidence));
      }
      return { imported: true, receipt };
    });
  } finally {
    await database.close();
  }
}

async function state(database: Executor): Promise<CanonicalState> {
  const read = async <T>(kind: string) => (await database.all<{ body: string }>("SELECT body FROM ttr_document WHERE kind = ? ORDER BY id", kind)).map(row => parse<T>(row.body));
  return { domains: await read<DomainDocument>("domain"), defects: await read<DefectDocument>("defect"), audit: await read<AuditReceiptDocument>("audit-receipt") };
}

export async function inspectCanonicalState(databasePath: string): Promise<CanonicalState> {
  const database = await open(databasePath, false);
  try {
    return await state(database);
  } finally {
    await database.close();
  }
}

export type FoundationOptions = { runSafeTask?: (task: Task) => Promise<void> | void };
export type FoundationStatus = CanonicalState;

export async function openTtrFoundation(databasePath: string, options: FoundationOptions = {}) {
  const database = await open(databasePath, true);
  const run = options.runSafeTask ?? (() => {});
  const resume = async () => {
    const tasks = await database.all<StoredTask>("SELECT id FROM ttr_maintenance_task WHERE status = 'pending' AND replay = 'safe' ORDER BY id");
    for (const task of tasks) {
      if (task.id !== "rebuild-status") throw new Error(`Unsupported durable TTR maintenance task: ${task.id}`);
      await run({ id: task.id, replay: "safe" });
      await database.run("UPDATE ttr_maintenance_task SET status = 'completed' WHERE id = ?", task.id);
    }
  };
  try {
    await resume();
  } catch (error) {
    await database.close();
    throw error;
  }
  return {
    status: () => state(database),
    close: () => database.close(),
    async intake(_input: unknown) { unsupported(); },
    async route(_input: unknown) { unsupported(); },
    async externalEffect(_input: unknown) { unsupported(); },
    async runTask(input: { id?: string; replay?: string }) {
      if (input.replay !== "safe") throw new Error("Only replay-safe maintenance tasks are available");
      if (input.id !== "rebuild-status") throw new Error("This maintenance task is not available");
      await database.run("INSERT OR IGNORE INTO ttr_maintenance_task (id, replay, status) VALUES (?, 'safe', 'pending')", input.id);
      await resume();
    },
  };
}
