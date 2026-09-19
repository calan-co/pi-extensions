import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type EvidenceType = "intake" | "validation" | "review" | "commit" | "deployment" | "requester-message" | "other";
export type CommitPhase = "pre-deployment" | "post-deployment" | "other";
export type RequesterMessageCategory =
  | "request-reproduction"
  | "request-logs"
  | "request-access"
  | "request-decision"
  | "request-authority"
  | "mitigation"
  | "stop-change"
  | "safe-to-proceed";

export interface AdminRecord {
  sessionId: string;
  registeredAt: string;
  active: boolean;
}

export interface PocRecord {
  domain: string;
  /** The first domain in a registration; aliases retain this canonical owner. */
  canonicalDomain?: string;
  sessionId: string;
  projectBoundary?: string;
  requesterChannel?: string;
  /** Friendly name assigned once to the Manager's Pi session. */
  managerName?: string;
  registeredAt: string;
  active: boolean;
}

export interface PocListEntry extends PocRecord { aliases: string[] }

export interface Evidence {
  id: string;
  type: EvidenceType;
  createdAt: string;
  status?: "passed" | "failed" | "recorded";
  path?: string;
  sha?: string;
  phase?: CommitPhase;
  artifact?: string;
  receipt?: string;
  verification?: string;
  category?: RequesterMessageCategory;
  delivery?: "not-delivered";
  message?: string;
}

export interface WorkItem {
  id: string;
  path: string;
  adapter: string;
  status: string;
  lifecycleStates: string[];
}

/** Append-only snapshot of an authoritative work item replaced by its owner POC. */
export interface WorkItemReassignmentAudit {
  previousWorkItem: WorkItem;
  reason: string;
  evidenceReferences: string[];
  reassignedAt: string;
  /** Present only when the prior work item was explicitly superseded. */
  successorWorkItem?: WorkItem;
  adminSessionId?: string;
}

export interface PocAssignment {
  sessionId: string;
  status: "active" | "orphaned";
  assignedAt: string;
}

export interface PocAssignmentAudit {
  previousAssignment: PocAssignment;
  reason: string;
  evidenceReferences: string[];
  changedAt: string;
  adminSessionId: string;
}

export interface Defect {
  id: string;
  domain: string;
  /** Current effective Manager; the original recipient remains in intake history. */
  ownerPocSessionId: string;
  pocAssignment?: PocAssignment;
  pocAssignmentHistory?: PocAssignmentAudit[];
  intake: {
    reporter: string;
    source: string;
    sourceDomain: string;
    targetPocSessionId: string;
    authorityConfirmed: boolean;
    symptom: string;
    impact: string;
    environment: string;
    reproduction: string;
    evidenceReferences: string[];
    recordedAt: string;
  };
  workItem?: WorkItem;
  /** Prior authoritative work items retained as immutable reassignment audit snapshots. */
  workItemHistory: WorkItemReassignmentAudit[];
  evidence: Evidence[];
  blocker?: string;
  nextAction?: string;
  statusHistory: Array<{ at: string; status: string; note?: string }>;
  /** Set only by a material work-item transition after deployment evidence. */
  postDeploymentWorkItemUpdatedAt?: string;
}

/** Repository integration seam. This global extension ships only the explicit-lifecycle adapter;
 * repository-specific adapters may synchronize paths/statuses outside this control-plane state. */
export interface WorkItemAdapter {
  name: string;
  lifecycleStates(workItemPath: string): Promise<string[]>;
  update?(workItem: WorkItem, defect: Defect): Promise<void>;
}

interface State {
  version: 1;
  /** Canonical POC records, keyed by canonical domain. */
  registrations: Record<string, PocRecord>;
  /** Every lookup domain, including canonical domains, mapped to its canonical record. */
  aliases?: Record<string, string>;
  /** Set after legacy per-alias records have been compacted. */
  pocRegistryVersion?: 2;
  defects: Record<string, Defect>;
  /** Explicitly enrolled administrative sessions; no Manager role implies this authority. */
  admins?: Record<string, AdminRecord>;
  /** Opt-in is per Pi session and persisted with the TTR control-plane state. */
  namingOptIns?: Record<string, true>;
}

export interface IntakeInput {
  reporter: string;
  source: string;
  /** The reporting system or domain; it never determines TTR ownership. */
  sourceDomain: string;
  /** The canonical TTR domain that owns the defect. */
  ownerDomain: string;
  /** The POC session explicitly addressed by the incoming report. */
  targetPocSessionId: string;
  symptom: string;
  impact: string;
  environment: string;
  reproduction: string;
  evidenceReferences: string[];
  currentSessionId: string;
}

export type OwnerResolvedIntakeInput = Omit<IntakeInput, "targetPocSessionId">;
type IntakeResult = { defect: Defect; role: "poc" | "non-poc" | "unassigned"; handoff?: { targetSessionId: string; delivery: "not-attempted"; payload: Record<string, unknown> } };

interface GitSnapshot { clean: boolean; head?: string }
type GitInspector = () => Promise<GitSnapshot>;

const allowedRequesterCategories = new Set<RequesterMessageCategory>([
  "request-reproduction", "request-logs", "request-access", "request-decision", "request-authority", "mitigation", "stop-change", "safe-to-proceed",
]);

function normalizedDomain(domain: string): string {
  const value = domain.trim().toLowerCase();
  if (!value) throw new Error("domain is required");
  return value;
}

const managerNames = "Avery Blair Cameron Casey Devon Drew Ellis Emery Finley Harper Hayden Jamie Jordan Kendall Lane Logan Morgan Parker Quinn Reese Riley Rowan Sage Sawyer Skyler Taylor Adrian Alex Amari Anderson Angel Ari Ashton Bailey Bellamy Blake Briar Brooklyn Charlie Dakota Dallas Eden Elliott Emerson Frankie Gray Harlow Hunter Indy Jules Kai Keegan Kennedy Lennon Marley Micah Milan Nico Oakley Peyton Phoenix Presley River Rory Remy Sasha Scout Shiloh Sutton Teagan Tatum Wren Aiden Alden Arlo August Bennett Caleb Callum Carter Clark Cole Connor Declan Dominic Elias Ethan Everett Felix Gabriel Gavin George Graham Henry Hudson Isaac Jack Jasper Julian Knox Leo Liam Luca Mason Miles Noah Nolan Oliver Owen Roman Samuel Silas Theo Thomas Victor Wesley Wyatt Zane Ada Alice Amelia Audrey Beatrice Celeste Clara Cora Daphne Eleanor Eliza Eva Florence Grace Hazel Iris Ivy June Lila Lily Luna Maeve Maya Mila Naomi Nora Olive Opal Penelope Phoebe Piper Poppy Ruby Sadie Sofia Stella Thea Violet Willow Zara".split(" ");

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function defaultState(): State { return { version: 1, registrations: {}, aliases: {}, pocRegistryVersion: 2, defects: {}, admins: {} }; }

/** Converts legacy per-alias records into canonical records plus a tiny alias index. */
function compactPocRegistry(state: State): State {
  if (state.pocRegistryVersion === 2) return state;
  const registrations: Record<string, PocRecord> = {};
  const aliases: Record<string, string> = {};
  const canonicalByIdentity = new Map<string, string>();
  const canonicalFor = (key: string, record: PocRecord): string => {
    const identity = JSON.stringify([record.sessionId, record.active]);
    const canonical = canonicalByIdentity.get(identity) ?? key;
    canonicalByIdentity.set(identity, canonical);
    registrations[canonical] ??= { ...record, domain: canonical, canonicalDomain: canonical };
    return canonical;
  };
  for (const [key, record] of Object.entries(state.registrations)) aliases[normalizedDomain(key)] = canonicalFor(normalizedDomain(key), record);
  for (const [alias, legacyCanonical] of Object.entries(state.aliases ?? {})) {
    const record = state.registrations[legacyCanonical];
    if (record) aliases[normalizedDomain(alias)] = canonicalFor(normalizedDomain(legacyCanonical), record);
  }
  return { ...state, registrations, aliases, pocRegistryVersion: 2 };
}

/** Durable, globally-scoped TTR control-plane core. It never transports messages or deploys. */
export class TriageControlPlane {
  constructor(private readonly options: {
    statePath: string;
    now?: () => string;
    git?: GitInspector;
    /** Explicit bootstrap allowlist for the first persisted admin; never inferred from Manager state. */
    bootstrapAdminSessionIds?: readonly string[];
    lockTimeoutMs?: number;
    random?: () => number;
  }) {}

  private now(): string { return this.options.now?.() ?? new Date().toISOString(); }
  private lockPath(): string { return `${this.options.statePath}.lock`; }

  private async acquireLock(): Promise<() => Promise<void>> {
    await mkdir(dirname(this.options.statePath), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + (this.options.lockTimeoutMs ?? 2_000);
    while (true) {
      try {
        const handle = await open(this.lockPath(), "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: this.now() }));
        await handle.close();
        return async () => { await rm(this.lockPath(), { force: true }); };
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) {
          throw new Error(`Unable to acquire triage-control-plane state lock: ${(error as Error).message}`);
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  }

  private async readState(): Promise<State> {
    try {
      const parsed = JSON.parse(await readFile(this.options.statePath, "utf8")) as State;
      if (parsed.version !== 1 || !parsed.registrations || !parsed.defects) throw new Error("unsupported state schema");
      return compactPocRegistry(parsed);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultState();
      throw new Error(`Cannot read triage-control-plane state: ${(error as Error).message}`);
    }
  }

  private async transaction<T>(fn: (state: State) => T): Promise<T> {
    const release = await this.acquireLock();
    try {
      const state = await this.readState();
      const result = fn(state);
      const tmpPath = `${this.options.statePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(tmpPath, this.options.statePath);
      return clone(result);
    } finally { await release(); }
  }

  async registerPoc(domain: string, input: Omit<PocRecord, "domain" | "registeredAt" | "active">, confirmReplacement: boolean): Promise<PocRecord> {
    return (await this.registerPocs([domain], input, confirmReplacement))[0]!;
  }

  async registerPocs(domains: string[], input: Omit<PocRecord, "domain" | "registeredAt" | "active">, confirmReplacement: boolean): Promise<PocRecord[]> {
    const keys = [...new Set(domains.map(normalizedDomain))];
    if (keys.length === 0) throw new Error("at least one POC domain is required");
    if (!input.sessionId?.trim()) throw new Error("POC sessionId is required and must come from Pi session APIs/environment");
    return this.transaction((state) => {
      for (const key of keys) {
        const current = this.findPoc(state, key);
        if (current?.active && current.sessionId !== input.sessionId.trim() && !confirmReplacement) {
          throw new Error(`Active POC registration for ${key} exists; explicit replacement confirmation is required`);
        }
      }
      this.assignMissingManagerNames(state);
      const canonicalDomain = keys[0]!;
      const registeredAt = this.now();
      const record: PocRecord = { domain: canonicalDomain, canonicalDomain, sessionId: input.sessionId.trim(), managerName: this.managerNameFor(state, input.sessionId.trim()), ...(input.projectBoundary ? { projectBoundary: input.projectBoundary } : {}), ...(input.requesterChannel ? { requesterChannel: input.requesterChannel } : {}), registeredAt, active: true };
      state.registrations[canonicalDomain] = record;
      state.aliases ??= {};
      for (const domain of keys) state.aliases[domain] = canonicalDomain;
      return keys.map(domain => ({ ...record, domain }));
    });
  }

  async resolvePoc(domain: string): Promise<PocRecord | undefined> {
    const record = this.findPoc(await this.readState(), normalizedDomain(domain));
    return record?.active ? clone(record) : undefined;
  }

  async setSessionNaming(sessionId: string, enabled: boolean): Promise<void> {
    const key = sessionId.trim();
    if (!key) throw new Error("Pi sessionId is required for session naming");
    await this.transaction((state) => {
      state.namingOptIns ??= {};
      if (enabled) state.namingOptIns[key] = true;
      else delete state.namingOptIns[key];
      return null;
    });
  }

  async isSessionNamingEnabled(sessionId: string): Promise<boolean> {
    const state = await this.readState();
    return state.namingOptIns?.[sessionId.trim()] === true;
  }

  async listPocs(includeInactive = false): Promise<PocListEntry[]> {
    const state = await this.readState();
    if (Object.values(state.registrations).some(record => !record.managerName)) {
      return this.transaction((next) => {
        this.assignMissingManagerNames(next);
        return this.listPocEntries(next, includeInactive);
      });
    }
    return this.listPocEntries(state, includeInactive);
  }

  /** Bootstrap authority is an explicit constructor allowlist; subsequent enrollment requires an active admin. */
  async registerAdmin(sessionId: string, actorSessionId: string): Promise<AdminRecord> {
    const target = sessionId.trim();
    const actor = actorSessionId?.trim();
    if (!target || !actor) throw new Error("admin and actor sessionId are required");
    return this.transaction((state) => {
      state.admins ??= {};
      const existing = state.admins[target];
      const bootstrapped = Object.keys(state.admins).length === 0 && (this.options.bootstrapAdminSessionIds ?? []).includes(target) && actor === target;
      if (!bootstrapped && !this.isActiveAdmin(state, actor)) {
        throw new Error("Only an active admin may register an admin; first admin must be explicitly bootstrapped");
      }
      if (existing && !existing.active) throw new Error(`Admin ${target} is deactivated and cannot be reactivated`);
      if (existing) return existing;
      const record: AdminRecord = { sessionId: target, registeredAt: this.now(), active: true };
      state.admins[target] = record;
      return record;
    });
  }

  async deactivateAdmin(sessionId: string, actorSessionId: string): Promise<AdminRecord> {
    const target = sessionId.trim();
    return this.transaction((state) => {
      this.requireAdminAuthority(state, actorSessionId);
      const admin = state.admins?.[target];
      if (!admin) throw new Error(`No admin registration for ${target}`);
      admin.active = false;
      return admin;
    });
  }

  async listAdmins(actorSessionId: string): Promise<AdminRecord[]> {
    const state = await this.readState();
    this.requireAdminAuthority(state, actorSessionId);
    return Object.values(state.admins ?? {}).map(clone);
  }

  async deactivatePoc(domain: string): Promise<PocRecord> {
    const key = normalizedDomain(domain);
    return this.transaction((state) => {
      const record = this.findPoc(state, key);
      if (!record) throw new Error(`No Manager registration for ${key}`);
      record.active = false;
      return record;
    });
  }

  /** Removes one domain alias, or every domain belonging to its Manager. */
  async unregisterPoc(domain: string, removeAll = false): Promise<{ removedDomains: string[] }> {
    const key = normalizedDomain(domain);
    return this.transaction((state) => {
      const canonicalDomain = state.aliases?.[key] ?? key;
      if (!state.registrations[canonicalDomain]) throw new Error(`No Manager registration for ${key}`);
      const domains = Object.entries(state.aliases ?? {}).filter(([, canonical]) => canonical === canonicalDomain).map(([alias]) => alias).sort();
      const removedDomains = removeAll ? domains : [key];
      if (!removeAll && !domains.includes(key)) throw new Error(`No Manager registration for ${key}`);
      for (const alias of removedDomains) delete state.aliases?.[alias];
      if (removeAll || domains.length === 1) {
        delete state.registrations[canonicalDomain];
        return { removedDomains };
      }
      if (key === canonicalDomain) {
        const replacement = domains.find(alias => alias !== key)!;
        const record = state.registrations[canonicalDomain]!;
        delete state.registrations[canonicalDomain];
        state.registrations[replacement] = { ...record, domain: replacement, canonicalDomain: replacement };
        for (const [alias, canonical] of Object.entries(state.aliases ?? {})) {
          if (canonical === canonicalDomain) state.aliases![alias] = replacement;
        }
      }
      return { removedDomains };
    });
  }

  private recordIntake(state: State, input: OwnerResolvedIntakeInput, targetPocSessionId: string): IntakeResult {
    const domain = normalizedDomain(input.ownerDomain);
    const sourceDomain = normalizedDomain(input.sourceDomain);
    const resolvedPoc = this.findPoc(state, domain);
    const poc = resolvedPoc?.active ? resolvedPoc : undefined;
    const authorityConfirmed = poc?.sessionId === targetPocSessionId && targetPocSessionId === input.currentSessionId;
    const id = `ttr-${randomUUID()}`;
    const recordedAt = this.now();
    const defect: Defect = {
      id, domain, ownerPocSessionId: poc?.sessionId ?? "unassigned",
      ...(poc ? { pocAssignment: { sessionId: poc.sessionId, status: "active" as const, assignedAt: recordedAt } } : {}),
      pocAssignmentHistory: [],
      intake: { reporter: input.reporter, source: input.source, sourceDomain, targetPocSessionId, authorityConfirmed, symptom: input.symptom, impact: input.impact, environment: input.environment, reproduction: input.reproduction, evidenceReferences: [...input.evidenceReferences], recordedAt },
      evidence: input.evidenceReferences.map(path => ({ id: randomUUID(), type: "intake", path, createdAt: recordedAt, status: "recorded" })),
      workItemHistory: [],
      statusHistory: [],
    };
    state.defects[id] = defect;
    if (!poc) return { defect, role: "unassigned" };
    if (authorityConfirmed) return { defect, role: "poc" };
    return {
      defect, role: "non-poc",
      handoff: {
        targetSessionId: poc.sessionId, delivery: "not-attempted",
        payload: { defectId: id, domain, sourceDomain, symptom: input.symptom, impact: input.impact, evidenceReferences: [...input.evidenceReferences] },
      },
    };
  }

  async intake(input: IntakeInput): Promise<IntakeResult> {
    const targetPocSessionId = input.targetPocSessionId?.trim();
    if (!targetPocSessionId) throw new Error("target POC sessionId is required for an incoming defect report");
    return this.transaction(state => this.recordIntake(state, input, targetPocSessionId));
  }

  async intakeForOwner(input: OwnerResolvedIntakeInput): Promise<IntakeResult> {
    const domain = normalizedDomain(input.ownerDomain);
    return this.transaction((state) => {
      const poc = this.findPoc(state, domain);
      const targetPocSessionId = poc?.active ? poc.sessionId : undefined;
      if (!targetPocSessionId) throw new Error(`No active POC registration for ${domain}; run /ttr register ${domain}`);
      return this.recordIntake(state, input, targetPocSessionId);
    });
  }

  async getDefect(defectId: string): Promise<Defect | undefined> {
    const state = await this.readState();
    return state.defects[defectId] ? clone(state.defects[defectId]!) : undefined;
  }

  async ensurePocAuthority(defectId: string, actorSessionId: string): Promise<Defect> {
    const state = await this.readState();
    return clone(this.requirePocAuthority(state, defectId, actorSessionId));
  }

  async reattestDefectAuthority(defectId: string, input: { sourceDomain: string; ownerDomain: string; targetPocSessionId: string; actorSessionId: string }): Promise<Defect> {
    const domain = normalizedDomain(input.ownerDomain);
    const sourceDomain = normalizedDomain(input.sourceDomain);
    const targetPocSessionId = input.targetPocSessionId?.trim();
    if (!targetPocSessionId) throw new Error("target POC sessionId is required for re-attestation");
    return this.transaction((state) => {
      const defect = this.requireDefect(state, defectId);
      if (defect.intake.authorityConfirmed === true) throw new Error(`Defect ${defectId} already has confirmed intake authority`);
      const poc = this.findPoc(state, domain);
      if (!poc?.active || poc.sessionId !== input.actorSessionId || targetPocSessionId !== input.actorSessionId) {
        throw new Error(`Session is not authorized to re-attest defect ${defectId} for ${domain}`);
      }
      defect.domain = domain;
      defect.ownerPocSessionId = poc.sessionId;
      defect.intake.sourceDomain = sourceDomain;
      defect.intake.targetPocSessionId = targetPocSessionId;
      defect.intake.authorityConfirmed = true;
      return defect;
    });
  }

  async assignWorkItem(defectId: string, workItem: Omit<WorkItem, "adapter"> & { adapter?: string }, actorSessionId: string): Promise<Defect> {
    return this.transaction((state) => {
      const defect = this.requirePocAuthority(state, defectId, actorSessionId);
      if (defect.workItem) throw new Error(`Defect ${defectId} already has an authoritative work item: ${defect.workItem.id}`);
      const assignedWorkItem = this.validateWorkItem(workItem);
      this.requireNoWorkItemCollision(state, defectId, assignedWorkItem);
      defect.workItem = assignedWorkItem;
      defect.statusHistory.push({ at: this.now(), status: assignedWorkItem.status, note: "authoritative work item assigned" });
      return defect;
    });
  }

  async reassignWorkItem(defectId: string, workItem: Omit<WorkItem, "adapter"> & { adapter?: string }, audit: { reason: string; evidenceReferences: string[] }, actorSessionId: string): Promise<Defect> {
    return this.transaction((state) => {
      const defect = this.requirePocAuthority(state, defectId, actorSessionId, "reassign");
      const previousWorkItem = this.requireWorkItem(defect);
      const replacement = this.validateWorkItem(workItem);
      if (!audit.reason?.trim() || !Array.isArray(audit.evidenceReferences) || audit.evidenceReferences.length === 0 || audit.evidenceReferences.some(reference => !reference.trim())) {
        throw new Error("reassignment reason and evidence references are required");
      }
      if (previousWorkItem.id === replacement.id || previousWorkItem.path === replacement.path) {
        throw new Error("replacement work item is the same as the authoritative work item");
      }
      this.requireNoWorkItemCollision(state, defectId, replacement);
      (defect.workItemHistory ??= []).push({
        previousWorkItem: clone(previousWorkItem),
        reason: audit.reason.trim(),
        evidenceReferences: [...audit.evidenceReferences],
        reassignedAt: this.now(),
      });
      defect.workItem = replacement;
      defect.statusHistory.push({ at: this.now(), status: replacement.status, note: "authoritative work item reassigned" });
      return defect;
    });
  }

  async adminLookup(actorSessionId: string): Promise<{ admins: AdminRecord[]; pocs: PocRecord[]; defects: Defect[]; assignments: Array<{ defectId: string; assignment: PocAssignment; orphaned: boolean }> }> {
    const state = await this.readState();
    this.requireAdminAuthority(state, actorSessionId);
    return {
      admins: Object.values(state.admins ?? {}).map(clone),
      pocs: Object.values(state.registrations).map(clone),
      defects: Object.values(state.defects).map(clone),
      assignments: Object.values(state.defects).map((defect) => {
        const assignment = this.pocAssignment(defect);
        const activePoc = this.findPoc(state, defect.domain);
        return { defectId: defect.id, assignment: clone(assignment), orphaned: assignment.status === "orphaned" || !activePoc?.active || activePoc.sessionId !== assignment.sessionId };
      }),
    };
  }

  async markPocAssignmentOrphaned(defectId: string, audit: { reason: string; evidenceReferences: string[] }, actorSessionId: string): Promise<Defect> {
    return this.transaction((state) => {
      this.requireAdminAuthority(state, actorSessionId);
      const defect = this.requireDefect(state, defectId);
      const previousAssignment = this.pocAssignment(defect);
      this.requireAudit(audit, "orphaning");
      if (previousAssignment.status === "orphaned") throw new Error(`Manager assignment for defect ${defectId} is already orphaned`);
      (defect.pocAssignmentHistory ??= []).push({ previousAssignment: clone(previousAssignment), reason: audit.reason.trim(), evidenceReferences: [...audit.evidenceReferences], changedAt: this.now(), adminSessionId: actorSessionId });
      defect.pocAssignment = { ...previousAssignment, status: "orphaned" };
      defect.statusHistory.push({ at: this.now(), status: "manager-assignment-orphaned", note: `admin marked Manager assignment orphaned: ${audit.reason.trim()}` });
      return defect;
    });
  }

  async adminRebindWorkItem(defectId: string, workItem: Omit<WorkItem, "adapter"> & { adapter?: string }, input: { targetPocSessionId: string; reason: string; evidenceReferences: string[] }, actorSessionId: string): Promise<Defect> {
    return this.transaction((state) => {
      this.requireAdminAuthority(state, actorSessionId);
      const defect = this.requireDefect(state, defectId);
      const previousWorkItem = this.requireWorkItem(defect);
      const replacement = this.validateWorkItem(workItem);
      this.requireAudit(input, "rebinding");
      this.requireActiveTargetPoc(state, defect, input.targetPocSessionId);
      if (previousWorkItem.id === replacement.id || previousWorkItem.path === replacement.path) throw new Error("replacement work item is the same as the authoritative work item");
      this.requireNoWorkItemCollision(state, defectId, replacement);
      const previousAssignment = this.pocAssignment(defect);
      (defect.workItemHistory ??= []).push({ previousWorkItem: clone(previousWorkItem), reason: input.reason.trim(), evidenceReferences: [...input.evidenceReferences], reassignedAt: this.now(), adminSessionId: actorSessionId });
      (defect.pocAssignmentHistory ??= []).push({ previousAssignment: clone(previousAssignment), reason: input.reason.trim(), evidenceReferences: [...input.evidenceReferences], changedAt: this.now(), adminSessionId: actorSessionId });
      defect.workItem = replacement;
      defect.ownerPocSessionId = input.targetPocSessionId.trim();
      defect.pocAssignment = { sessionId: input.targetPocSessionId.trim(), status: "active", assignedAt: this.now() };
      defect.statusHistory.push({ at: this.now(), status: replacement.status, note: "admin authoritative work item rebound" });
      return defect;
    });
  }

  async supersedeWorkItem(defectId: string, workItem: Omit<WorkItem, "adapter"> & { adapter?: string }, audit: { reason: string; evidenceReferences: string[] }, actorSessionId: string): Promise<Defect> {
    return this.transaction((state) => {
      this.requireAdminAuthority(state, actorSessionId);
      const defect = this.requireDefect(state, defectId);
      const previousWorkItem = this.requireWorkItem(defect);
      const successor = this.validateWorkItem(workItem);
      this.requireAudit(audit, "supersession");
      if (previousWorkItem.id === successor.id || previousWorkItem.path === successor.path) throw new Error("successor work item is the same as the authoritative work item");
      this.requireNoWorkItemCollision(state, defectId, successor);
      (defect.workItemHistory ??= []).push({ previousWorkItem: clone(previousWorkItem), successorWorkItem: clone(successor), reason: audit.reason.trim(), evidenceReferences: [...audit.evidenceReferences], reassignedAt: this.now(), adminSessionId: actorSessionId });
      defect.workItem = successor;
      defect.statusHistory.push({ at: this.now(), status: successor.status, note: "authoritative work item superseded by admin" });
      return defect;
    });
  }

  async transitionWorkItem(defectId: string, status: string, updates: { blocker?: string; nextAction?: string } = {}): Promise<Defect> {
    return this.transaction((state) => {
      const defect = this.requireDefect(state, defectId);
      const workItem = this.requireWorkItem(defect);
      if (!workItem.lifecycleStates.includes(status)) throw new Error(`Status ${status} is not configured by the authoritative work-item lifecycle`);
      workItem.status = status;
      if (updates.blocker !== undefined) defect.blocker = updates.blocker || undefined;
      if (updates.nextAction !== undefined) defect.nextAction = updates.nextAction || undefined;
      const at = this.now();
      defect.statusHistory.push({ at, status, ...(defect.blocker ? { note: `blocker: ${defect.blocker}` } : {}) });
      if (defect.evidence.some(item => item.type === "deployment")) defect.postDeploymentWorkItemUpdatedAt = at;
      return defect;
    });
  }

  async recordEvidence(defectId: string, evidence: Omit<Evidence, "id" | "createdAt">): Promise<Evidence> {
    return this.transaction((state) => {
      const defect = this.requireDefect(state, defectId);
      const record: Evidence = { id: `evidence-${randomUUID()}`, createdAt: this.now(), ...evidence };
      defect.evidence.push(record);
      return record;
    });
  }

  async recordCommitEvidence(defectId: string, input: { sha: string; phase: CommitPhase; path: string }): Promise<Evidence> {
    if (!/^[0-9A-Za-z][0-9A-Za-z._/-]*$/.test(input.sha)) throw new Error("commit SHA is required");
    if (input.phase === "post-deployment") {
      const defect = await this.getDefect(defectId);
      if (!defect?.postDeploymentWorkItemUpdatedAt) {
        throw new Error("Record a final authoritative work-item transition after deployment before linking post-deployment commit evidence");
      }
      const preDeploymentShas = new Set(defect.evidence
        .filter(item => item.type === "commit" && item.phase === "pre-deployment" && item.sha)
        .map(item => item.sha));
      if (preDeploymentShas.size === 0 || preDeploymentShas.has(input.sha)) {
        throw new Error("Post-deployment commit evidence requires a distinct pre-deployment commit SHA");
      }
    }
    return this.recordEvidence(defectId, { type: "commit", status: "recorded", sha: input.sha, phase: input.phase, path: input.path });
  }

  async recordDeploymentEvidence(defectId: string, input: { artifact: string; receipt: string; verification: string }): Promise<Evidence> {
    if (!input.artifact || !input.receipt || !input.verification) throw new Error("deployment artifact, receipt, and verification are required");
    const gate = await this.checkReleaseGate(defectId, { deploymentRequired: false });
    if (!gate.ok) throw new Error(`Deployment evidence blocked by release gate: ${gate.missing.join(", ")}`);
    const defect = await this.getDefect(defectId);
    const preDeploymentCommit = defect?.evidence.find(item => item.type === "commit" && item.phase === "pre-deployment" && item.sha);
    if (!preDeploymentCommit) {
      throw new Error("Deployment evidence requires linked pre-deployment commit evidence");
    }
    if (gate.head && preDeploymentCommit.sha !== gate.head) {
      throw new Error("Deployment evidence requires pre-deployment commit evidence matching the current Git HEAD");
    }
    return this.recordEvidence(defectId, { type: "deployment", status: "recorded", artifact: input.artifact, receipt: input.receipt, verification: input.verification });
  }

  async checkReleaseGate(defectId: string, options: { deploymentRequired: boolean }): Promise<{ ok: boolean; missing: string[]; head?: string }> {
    const defect = await this.getDefect(defectId);
    const git: GitSnapshot = await (this.options.git?.() ?? Promise.resolve<GitSnapshot>({ clean: false }));
    const missing: string[] = [];
    if (!defect?.workItem) missing.push("authoritative-work-item");
    if (!git.clean) missing.push("clean-working-tree");
    const evidence = defect?.evidence ?? [];
    const hasCommit = evidence.some(item => item.type === "commit" && Boolean(item.sha));
    const hasPreDeploymentCommit = evidence.some(item => item.type === "commit" && item.phase === "pre-deployment" && Boolean(item.sha));
    if (options.deploymentRequired ? !hasPreDeploymentCommit : !hasCommit) missing.push("commit-evidence");
    if (!evidence.some(item => item.type === "validation" && item.status === "passed")) missing.push("validation-evidence");
    if (!evidence.some(item => item.type === "review" && item.status === "passed")) missing.push("review-evidence");
    if (options.deploymentRequired) {
      if (!evidence.some(item => item.type === "deployment" && item.artifact && item.receipt && item.verification)) missing.push("release-artifact", "deployment-evidence");
      if (!defect?.postDeploymentWorkItemUpdatedAt) missing.push("final-work-item-update");
      const preDeploymentShas = new Set(evidence.filter(item => item.type === "commit" && item.phase === "pre-deployment" && item.sha).map(item => item.sha));
      const finalCommit = evidence.some(item => item.type === "commit" && item.phase === "post-deployment" && item.sha && !preDeploymentShas.has(item.sha) && (!git.head || item.sha === git.head));
      if (!finalCommit) missing.push("final-post-deployment-commit-evidence");
    }
    return { ok: missing.length === 0, missing, ...(git.head ? { head: git.head } : {}) };
  }

  async recordRequesterMessage(defectId: string, category: RequesterMessageCategory | string, message: string, options: { deploymentRequired?: boolean } = {}): Promise<Evidence> {
    if (!allowedRequesterCategories.has(category as RequesterMessageCategory)) throw new Error(`Unsupported requester-message category: ${category}`);
    if (!message.trim()) throw new Error("requester message is required");
    if (category === "safe-to-proceed") {
      const gate = await this.checkReleaseGate(defectId, { deploymentRequired: options.deploymentRequired ?? false });
      if (!gate.ok) throw new Error(`Safe-to-proceed requester message blocked by release gate: ${gate.missing.join(", ")}`);
    }
    return this.recordEvidence(defectId, { type: "requester-message", status: "recorded", category: category as RequesterMessageCategory, message: message.trim(), delivery: "not-delivered" });
  }

  private managerNameFor(state: State, sessionId: string): string {
    const existing = Object.values(state.registrations).find(record => record.sessionId === sessionId)?.managerName;
    if (existing) return existing;
    const taken = new Set(Object.values(state.registrations).map(record => record.managerName).filter(Boolean));
    const available = managerNames.filter(name => !taken.has(name));
    if (available.length === 0) throw new Error("No friendly Manager names remain");
    return available[Math.floor((this.options.random?.() ?? Math.random()) * available.length)]!;
  }
  private assignMissingManagerNames(state: State): void {
    for (const record of Object.values(state.registrations)) record.managerName ??= this.managerNameFor(state, record.sessionId);
  }
  private listPocEntries(state: State, includeInactive: boolean): PocListEntry[] {
    return Object.entries(state.registrations)
      .filter(([, record]) => includeInactive || record.active)
      .map(([domain, record]) => ({ ...clone(record), aliases: Object.entries(state.aliases ?? {}).filter(([, canonical]) => canonical === domain).map(([alias]) => alias).sort() }))
      .sort((left, right) => left.domain.localeCompare(right.domain));
  }
  private findPoc(state: State, domain: string): PocRecord | undefined {
    return state.registrations[state.aliases?.[domain] ?? domain];
  }
  private isActiveAdmin(state: State, sessionId: string): boolean { return state.admins?.[sessionId]?.active === true; }
  private requireAdminAuthority(state: State, actorSessionId: string): void {
    if (!actorSessionId?.trim() || !this.isActiveAdmin(state, actorSessionId.trim())) throw new Error("Session is not an explicitly enrolled active TTR admin");
  }
  private pocAssignment(defect: Defect): PocAssignment {
    return defect.pocAssignment ?? { sessionId: defect.ownerPocSessionId, status: "active", assignedAt: defect.intake.recordedAt };
  }
  private requireAudit(audit: { reason: string; evidenceReferences: string[] }, action: string): void {
    if (!audit.reason?.trim() || !Array.isArray(audit.evidenceReferences) || audit.evidenceReferences.length === 0 || audit.evidenceReferences.some(reference => !reference.trim())) {
      throw new Error(`${action} reason and evidence references are required`);
    }
  }
  private requireActiveTargetPoc(state: State, defect: Defect, sessionId: string): void {
    const target = sessionId?.trim();
    const poc = this.findPoc(state, defect.domain);
    if (!target || !poc?.active || poc.sessionId !== target) throw new Error(`Target session is not the active Manager for defect domain ${defect.domain}`);
  }

  private validateWorkItem(workItem: Omit<WorkItem, "adapter"> & { adapter?: string }): WorkItem {
    if (!workItem.id?.trim() || !workItem.path?.trim() || !workItem.status?.trim() || !Array.isArray(workItem.lifecycleStates) || workItem.lifecycleStates.length === 0 || workItem.lifecycleStates.some(status => !status.trim())) {
      throw new Error("work-item id, path, status, and configured lifecycleStates are required");
    }
    if (!workItem.lifecycleStates.includes(workItem.status)) throw new Error("initial work-item status must be in configured lifecycleStates");
    return { ...workItem, lifecycleStates: [...workItem.lifecycleStates], adapter: workItem.adapter ?? "explicit-lifecycle" };
  }
  private requireNoWorkItemCollision(state: State, defectId: string, workItem: WorkItem): void {
    const duplicate = Object.values(state.defects).find(other => other.id !== defectId && (other.workItem?.id === workItem.id || other.workItem?.path === workItem.path));
    if (duplicate) throw new Error(`Work item ${workItem.id} is already authoritative for defect ${duplicate.id}`);
  }
  private requireDefect(state: State, defectId: string): Defect { const defect = state.defects[defectId]; if (!defect) throw new Error(`Unknown defect: ${defectId}`); return defect; }
  private requirePocAuthority(state: State, defectId: string, actorSessionId: string, action = "assign"): Defect {
    const defect = this.requireDefect(state, defectId);
    const activePoc = this.findPoc(state, defect.domain);
    const assignment = this.pocAssignment(defect);
    const originalAuthorityOrAdminRebind = defect.intake.targetPocSessionId === actorSessionId || defect.pocAssignmentHistory?.some(item => item.adminSessionId && assignment.sessionId === actorSessionId);
    if (!defect.intake.authorityConfirmed || assignment.status !== "active" || assignment.sessionId !== actorSessionId || defect.ownerPocSessionId !== actorSessionId || !originalAuthorityOrAdminRebind || !activePoc?.active || activePoc.sessionId !== actorSessionId) {
      throw new Error(`Session is not authorized to ${action} a work item for defect ${defectId}`);
    }
    return defect;
  }
  private requireWorkItem(defect: Defect): WorkItem { if (!defect.workItem) throw new Error(`Defect ${defect.id} has no authoritative work item`); return defect.workItem; }
}
