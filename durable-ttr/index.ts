import { access, constants } from "node:fs/promises";
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineDoc, defineExtension, defineTask } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { HarnessOptions } from "@earendil-works/pi-durable";

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

type Task = { id: "rebuild-status"; replay: "safe" };
type ImportDocument = { hashes: string[] };
type MetadataDocument = { records: { sourceHash: string; source: CanonicalSnapshot["source"] }[] };

const DomainRegistry = defineDoc<{ domains: DomainDocument[] }>({
  kind: "ttr.domain-registry", version: 1, scope: "session", initial: () => ({ domains: [] }), checkpointWhen: () => true,
});
const DefectRecords = defineDoc<{ defects: DefectDocument[] }>({
  kind: "ttr.defect-records", version: 1, scope: "session", initial: () => ({ defects: [] }), checkpointWhen: () => true,
});
const ImportReceipts = defineDoc<{ receipts: AuditReceiptDocument[] }>({
  kind: "ttr.import-receipts", version: 1, scope: "session", initial: () => ({ receipts: [] }), checkpointWhen: () => true,
});
const ImportMetadata = defineDoc<MetadataDocument>({
  kind: "ttr.migration-metadata", version: 1, scope: "session", initial: () => ({ records: [] }), checkpointWhen: () => true,
});
const ImportedSources = defineDoc<ImportDocument>({
  kind: "ttr.imported-sources", version: 1, scope: "session", initial: () => ({ hashes: [] }), checkpointWhen: () => true,
});

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
const sourceHash = (snapshot: CanonicalSnapshot) => createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
const unsupported = (): never => { throw new Error("Live intake, routing, and external effects are not available in the durable TTR foundation"); };
// ponytail: no model may run until a later routing stage supplies one.
const noModels = {
  getProviders: () => [], getProvider: () => undefined, getModels: () => [], getModel: () => undefined,
  getModelsOfType: () => [], getModelOfType: () => undefined, getAllModels: () => [],
  refresh: async () => ({ aborted: false, errors: new Map() }), checkAuth: async () => undefined,
  getAvailable: async () => [], getAvailableOfType: async () => [], getAllAvailable: async () => [], getAuth: async () => undefined,
  login: async () => { throw new Error("Model execution is unavailable in the durable TTR foundation"); },
  logout: async () => {}, stream: () => { throw new Error("Model execution is unavailable in the durable TTR foundation"); },
  complete: async () => { throw new Error("Model execution is unavailable in the durable TTR foundation"); },
  streamSimple: () => { throw new Error("Model execution is unavailable in the durable TTR foundation"); },
  completeSimple: async () => { throw new Error("Model execution is unavailable in the durable TTR foundation"); },
  streamDeferred: () => { throw new Error("Model execution is unavailable in the durable TTR foundation"); },
  fetchDeferred: async () => { throw new Error("Model execution is unavailable in the durable TTR foundation"); },
  cancelDeferred: async () => { throw new Error("Model execution is unavailable in the durable TTR foundation"); },
  generateImages: async () => { throw new Error("Model execution is unavailable in the durable TTR foundation"); },
  classify: async () => { throw new Error("Model execution is unavailable in the durable TTR foundation"); },
} as HarnessOptions["models"];

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

export type FoundationOptions = { runSafeTask?: (task: Task, signal: AbortSignal) => Promise<void> | void };
export type FoundationStatus = CanonicalState;

function maintenanceTask(run: NonNullable<FoundationOptions["runSafeTask"]>) {
  return defineTask<undefined, { phase: "run" }, null>({
    name: "ttr.rebuild-status", version: 1, initial: () => ({ phase: "run" }),
    phases: {
      run: async (_task, runtime, context) => {
        await run({ id: "rebuild-status", replay: "safe" }, runtime.signal);
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });
}

async function openFoundation(databasePath: string, options: FoundationOptions = {}) {
  const registry = createRegistry();
  const task = maintenanceTask(options.runSafeTask ?? (() => {}));
  registry.install(defineExtension({ name: "ttr-foundation", tasks: [task] }));
  return { harness: await Harness.open(await openNodeSqliteStorage(databasePath), { models: noModels, registry }, BACKGROUND_CONTEXT), task };
}

async function state(harness: Awaited<ReturnType<typeof Harness.open>>): Promise<CanonicalState> {
  const [domains, defects, audit] = await Promise.all([
    harness.snapshot(DomainRegistry, BACKGROUND_CONTEXT),
    harness.snapshot(DefectRecords, BACKGROUND_CONTEXT),
    harness.snapshot(ImportReceipts, BACKGROUND_CONTEXT),
  ]);
  return structuredClone({ domains: domains?.domains ?? [], defects: defects?.defects ?? [], audit: audit?.receipts ?? [] });
}

export async function importCanonicalSnapshot(databasePath: string, snapshot: CanonicalSnapshot): Promise<ImportResult> {
  validateSnapshot(snapshot);
  const hash = sourceHash(snapshot);
  const { harness } = await openFoundation(databasePath);
  try {
    return await harness.commit(async tx => {
      const imported = await tx.doc(ImportedSources);
      const receipts = await tx.doc(ImportReceipts);
      if (imported.hashes.includes(hash)) {
        const receipt = receipts.receipts.find(item => item.sourceHash === hash);
        if (!receipt) throw new Error("Imported source is missing its audit receipt");
        return { imported: false, receipt: { sourceHash: receipt.sourceHash, sourceVersion: receipt.sourceVersion, importedAt: receipt.importedAt } };
      }
      if (imported.hashes.length) throw new Error("The durable TTR foundation accepts only one canonical snapshot");
      const receipt: AuditReceiptDocument = { sourceHash: hash, sourceVersion: snapshot.source.version, importedAt: new Date().toISOString() };
      (await tx.doc(DomainRegistry)).domains = structuredClone(snapshot.domains);
      (await tx.doc(DefectRecords)).defects = structuredClone(snapshot.defects);
      (await tx.doc(ImportMetadata)).records.push({ sourceHash: hash, source: structuredClone(snapshot.source) });
      receipts.receipts.push(receipt);
      imported.hashes.push(hash);
      return { imported: true, receipt };
    }, BACKGROUND_CONTEXT);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

export async function inspectCanonicalState(databasePath: string): Promise<CanonicalState> {
  try {
    await access(databasePath, constants.F_OK);
  } catch {
    throw new Error("Durable TTR foundation database does not exist");
  }
  const { harness } = await openFoundation(databasePath);
  try {
    return await state(harness);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

export async function openTtrFoundation(databasePath: string, options: FoundationOptions = {}) {
  const { harness, task } = await openFoundation(databasePath, options);
  harness.resume();
  return {
    status: () => state(harness),
    close: () => harness.close(BACKGROUND_CONTEXT),
    async intake(_input: unknown) { unsupported(); },
    async route(_input: unknown) { unsupported(); },
    async externalEffect(_input: unknown) { unsupported(); },
    async runTask(input: { id?: string; replay?: string }) {
      if (input.replay !== "safe") throw new Error("Only replay-safe maintenance tasks are available");
      if (input.id !== "rebuild-status") throw new Error("This maintenance task is not available");
      const root = await harness.root(BACKGROUND_CONTEXT);
      const id = await root.commit(tx => tx.createTask(task, undefined, { ownership: { kind: "conversation" } }), BACKGROUND_CONTEXT);
      harness.resume();
      const settled = await harness.waitForTask(id, BACKGROUND_CONTEXT);
      if (settled.state.outcome.status !== "completed") throw new Error(`Replay-safe maintenance task did not complete: ${settled.state.outcome.status}`);
    },
  };
}
