import { createHash } from "node:crypto";
import { access, constants } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { HarnessOptions } from "@earendil-works/pi-durable";

export type PilotManifest = {
  domain: "ttr-pilot";
  version: number;
  repositoryBoundary: string;
  routing: { id: string; sourceDomains: string[] }[];
  outboxAdapter: "noop-shadow-receipt";
};
export type PilotReport = { id: string; repository: string; sourceDomain: string; summary: string };
export type ShadowDecision = { id: string; reportId: string; manifestHash: string; routeId: string };
export type NoopOutboxReceipt = { id: string; decisionId: string; adapter: "noop-shadow-receipt" };
export type PilotState = { decisions: ShadowDecision[]; outbox: NoopOutboxReceipt[] };
export type ShadowSubmission = { report: PilotReport; manifestHash: string; manifestVersion: number; mode: "shadow" };

const Decisions = defineDoc<{ decisions: ShadowDecision[] }>({
  kind: "ttr-pilot.shadow-decisions", version: 1, scope: "session", initial: () => ({ decisions: [] }), checkpointWhen: () => true,
});
const Outbox = defineDoc<{ outbox: NoopOutboxReceipt[] }>({
  kind: "ttr-pilot.noop-outbox", version: 1, scope: "session", initial: () => ({ outbox: [] }), checkpointWhen: () => true,
});

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const string = (value: unknown, label: string): value is string => {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return true;
};
const record = (value: unknown, label: string): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return true;
};

export function validatePilotManifest(value: unknown): string {
  record(value, "manifest");
  if (value.domain !== "ttr-pilot") throw new TypeError("manifest.domain must be ttr-pilot");
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) throw new TypeError("manifest.version must be a positive integer");
  string(value.repositoryBoundary, "manifest.repositoryBoundary");
  if (!Array.isArray(value.routing) || !value.routing.length) throw new TypeError("manifest.routing must be a non-empty array");
  const routes = new Set<string>();
  for (const route of value.routing) {
    record(route, "manifest route");
    string(route.id, "manifest route.id");
    if (routes.has(route.id)) throw new TypeError("duplicate manifest route");
    routes.add(route.id);
    if (!Array.isArray(route.sourceDomains) || !route.sourceDomains.length) throw new TypeError("manifest route.sourceDomains must be a non-empty array");
    route.sourceDomains.forEach(sourceDomain => string(sourceDomain, "manifest route.sourceDomain"));
  }
  if (value.outboxAdapter !== "noop-shadow-receipt") throw new TypeError("manifest.outboxAdapter must be noop-shadow-receipt");
  return hash(value);
}

export function hashPilotManifest(manifest: PilotManifest): string {
  return validatePilotManifest(manifest);
}

function validateReport(value: unknown, manifest: PilotManifest): asserts value is PilotReport {
  record(value, "report");
  string(value.id, "report.id");
  string(value.repository, "report.repository");
  string(value.sourceDomain, "report.sourceDomain");
  string(value.summary, "report.summary");
  if (value.repository !== manifest.repositoryBoundary) throw new Error("report repository is outside the pilot boundary");
}

export function selectShadowRoute(manifest: PilotManifest, report: PilotReport): { id: string } {
  validatePilotManifest(manifest);
  validateReport(report, manifest);
  const route = manifest.routing.find(candidate => candidate.sourceDomains.includes(report.sourceDomain) || candidate.sourceDomains.includes("*"));
  if (!route) throw new Error("no shadow route matches report");
  return { id: route.id };
}

const noModels = {
  getProviders: () => [], getProvider: () => undefined, getModels: () => [], getModel: () => undefined,
  getModelsOfType: () => [], getModelOfType: () => undefined, getAllModels: () => [],
  refresh: async () => ({ aborted: false, errors: new Map() }), checkAuth: async () => undefined,
  getAvailable: async () => [], getAvailableOfType: async () => [], getAllAvailable: async () => [], getAuth: async () => undefined,
  login: async () => { throw new Error("Model execution is unavailable in ttr-pilot"); }, logout: async () => {},
  stream: () => { throw new Error("Model execution is unavailable in ttr-pilot"); }, complete: async () => { throw new Error("Model execution is unavailable in ttr-pilot"); },
  streamSimple: () => { throw new Error("Model execution is unavailable in ttr-pilot"); }, completeSimple: async () => { throw new Error("Model execution is unavailable in ttr-pilot"); },
  streamDeferred: () => { throw new Error("Model execution is unavailable in ttr-pilot"); }, fetchDeferred: async () => { throw new Error("Model execution is unavailable in ttr-pilot"); },
  cancelDeferred: async () => { throw new Error("Model execution is unavailable in ttr-pilot"); }, generateImages: async () => { throw new Error("Model execution is unavailable in ttr-pilot"); },
  classify: async () => { throw new Error("Model execution is unavailable in ttr-pilot"); },
} as HarnessOptions["models"];

async function open(databasePath: string) {
  return Harness.open(await openNodeSqliteStorage(databasePath), { models: noModels, registry: createRegistry() }, BACKGROUND_CONTEXT);
}
async function state(harness: Awaited<ReturnType<typeof Harness.open>>): Promise<PilotState> {
  const [decisions, outbox] = await Promise.all([harness.snapshot(Decisions, BACKGROUND_CONTEXT), harness.snapshot(Outbox, BACKGROUND_CONTEXT)]);
  return structuredClone({ decisions: decisions?.decisions ?? [], outbox: outbox?.outbox ?? [] });
}

export async function inspectTtrPilot(databasePath: string): Promise<PilotState> {
  try { await access(databasePath, constants.F_OK); } catch { throw new Error("TTR pilot database does not exist"); }
  const harness = await open(databasePath);
  try { return await state(harness); } finally { await harness.close(BACKGROUND_CONTEXT); }
}

export async function openTtrPilot(options: { databasePath: string; manifest: PilotManifest; manifestHash: string }) {
  const currentHash = validatePilotManifest(options.manifest);
  if (options.manifestHash !== currentHash) throw new Error("manifest hash does not match manifest");
  const manifest = structuredClone(options.manifest);
  const harness = await open(options.databasePath);
  return {
    inspect: () => state(harness),
    close: () => harness.close(BACKGROUND_CONTEXT),
    async submitShadowReport(input: ShadowSubmission): Promise<ShadowDecision & { outbox: NoopOutboxReceipt }> {
      if (input.mode !== "shadow") throw new Error("only shadow mode is available");
      if (input.manifestHash !== currentHash) throw new Error("manifest hash is stale or does not match manifest");
      if (input.manifestVersion !== manifest.version) throw new Error("manifest version is stale");
      const route = selectShadowRoute(manifest, input.report);
      const decision: ShadowDecision = { id: `shadow-decision-${hash({ manifestHash: currentHash, report: input.report, routeId: route.id })}`, reportId: input.report.id, manifestHash: currentHash, routeId: route.id };
      const outbox: NoopOutboxReceipt = { id: `noop-outbox-${hash(decision)}`, decisionId: decision.id, adapter: "noop-shadow-receipt" };
      return harness.commit(async tx => {
        const decisions = await tx.doc(Decisions);
        const receipts = await tx.doc(Outbox);
        const existing = decisions.decisions.find(item => item.id === decision.id);
        if (existing) {
          const receipt = receipts.outbox.find(item => item.decisionId === existing.id);
          if (!receipt) throw new Error("shadow decision is missing its no-op outbox receipt");
          return { ...existing, outbox: { ...receipt } };
        }
        decisions.decisions.push(decision);
        receipts.outbox.push(outbox);
        return { ...decision, outbox: { ...outbox } };
      }, BACKGROUND_CONTEXT);
    },
  };
}
