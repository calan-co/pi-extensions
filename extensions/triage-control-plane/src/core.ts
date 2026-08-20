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

export interface PocRecord {
  domain: string;
  sessionId: string;
  projectBoundary?: string;
  requesterChannel?: string;
  registeredAt: string;
  active: boolean;
}

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

export interface Defect {
  id: string;
  domain: string;
  ownerPocSessionId: string;
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
  registrations: Record<string, PocRecord>;
  defects: Record<string, Defect>;
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

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function defaultState(): State { return { version: 1, registrations: {}, defects: {} }; }

/** Durable, globally-scoped TTR control-plane core. It never transports messages or deploys. */
export class TriageControlPlane {
  constructor(private readonly options: {
    statePath: string;
    now?: () => string;
    git?: GitInspector;
    lockTimeoutMs?: number;
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
      return parsed;
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
        const current = state.registrations[key];
        if (current?.active && current.sessionId !== input.sessionId.trim() && !confirmReplacement) {
          throw new Error(`Active POC registration for ${key} exists; explicit replacement confirmation is required`);
        }
      }
      const registeredAt = this.now();
      return keys.map((domain) => {
        const record: PocRecord = { domain, sessionId: input.sessionId.trim(), ...(input.projectBoundary ? { projectBoundary: input.projectBoundary } : {}), ...(input.requesterChannel ? { requesterChannel: input.requesterChannel } : {}), registeredAt, active: true };
        state.registrations[domain] = record;
        return record;
      });
    });
  }

  async resolvePoc(domain: string): Promise<PocRecord | undefined> {
    const state = await this.readState();
    const record = state.registrations[normalizedDomain(domain)];
    return record?.active ? clone(record) : undefined;
  }

  async listPocs(includeInactive = false): Promise<PocRecord[]> {
    const state = await this.readState();
    return Object.values(state.registrations).filter(item => includeInactive || item.active).map(clone);
  }

  async deactivatePoc(domain: string): Promise<PocRecord> {
    const key = normalizedDomain(domain);
    return this.transaction((state) => {
      const record = state.registrations[key];
      if (!record) throw new Error(`No POC registration for ${key}`);
      record.active = false;
      return record;
    });
  }

  async intake(input: IntakeInput): Promise<{ defect: Defect; role: "poc" | "non-poc" | "unassigned"; handoff?: { targetSessionId: string; delivery: "not-attempted"; payload: Record<string, unknown> } }> {
    const domain = normalizedDomain(input.ownerDomain);
    const sourceDomain = normalizedDomain(input.sourceDomain);
    const targetPocSessionId = input.targetPocSessionId?.trim();
    if (!targetPocSessionId) throw new Error("target POC sessionId is required for an incoming defect report");
    return this.transaction((state) => {
      const poc = state.registrations[domain]?.active ? state.registrations[domain] : undefined;
      const authorityConfirmed = poc?.sessionId === targetPocSessionId && targetPocSessionId === input.currentSessionId;
      const id = `ttr-${randomUUID()}`;
      const recordedAt = this.now();
      const defect: Defect = {
        id, domain, ownerPocSessionId: poc?.sessionId ?? "unassigned",
        intake: { reporter: input.reporter, source: input.source, sourceDomain, targetPocSessionId, authorityConfirmed, symptom: input.symptom, impact: input.impact, environment: input.environment, reproduction: input.reproduction, evidenceReferences: [...input.evidenceReferences], recordedAt },
        evidence: input.evidenceReferences.map(path => ({ id: randomUUID(), type: "intake", path, createdAt: recordedAt, status: "recorded" })),
        statusHistory: [],
      };
      state.defects[id] = defect;
      if (!poc) return { defect, role: "unassigned" as const };
      if (authorityConfirmed) return { defect, role: "poc" as const };
      return {
        defect, role: "non-poc" as const,
        handoff: {
          targetSessionId: poc.sessionId, delivery: "not-attempted" as const,
          payload: { defectId: id, domain, sourceDomain, symptom: input.symptom, impact: input.impact, evidenceReferences: [...input.evidenceReferences] },
        },
      };
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
      const poc = state.registrations[domain];
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
      if (!workItem.id || !workItem.path || !workItem.status || workItem.lifecycleStates.length === 0) throw new Error("work-item id, path, status, and configured lifecycleStates are required");
      if (!workItem.lifecycleStates.includes(workItem.status)) throw new Error("initial work-item status must be in configured lifecycleStates");
      const duplicate = Object.values(state.defects).find(other => other.id !== defectId && other.workItem?.id === workItem.id);
      if (duplicate) throw new Error(`Work item ${workItem.id} is already authoritative for defect ${duplicate.id}`);
      defect.workItem = { ...workItem, lifecycleStates: [...workItem.lifecycleStates], adapter: workItem.adapter ?? "explicit-lifecycle" };
      defect.statusHistory.push({ at: this.now(), status: workItem.status, note: "authoritative work item assigned" });
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

  private requireDefect(state: State, defectId: string): Defect { const defect = state.defects[defectId]; if (!defect) throw new Error(`Unknown defect: ${defectId}`); return defect; }
  private requirePocAuthority(state: State, defectId: string, actorSessionId: string): Defect {
    const defect = this.requireDefect(state, defectId);
    const activePoc = state.registrations[defect.domain];
    if (!defect.intake.authorityConfirmed || defect.ownerPocSessionId !== actorSessionId || defect.intake.targetPocSessionId !== actorSessionId || !activePoc?.active || activePoc.sessionId !== actorSessionId) {
      throw new Error(`Session is not authorized to assign a work item for defect ${defectId}`);
    }
    return defect;
  }
  private requireWorkItem(defect: Defect): WorkItem { if (!defect.workItem) throw new Error(`Defect ${defect.id} has no authoritative work item`); return defect.workItem; }
}
