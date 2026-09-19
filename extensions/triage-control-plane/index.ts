import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { TriageControlPlane, type PocListEntry, type RequesterMessageCategory } from "./src/core.ts";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const STATE_PATH = join(AGENT_DIR, "triage-control-plane", "state.json");
/** Explicit bootstrap allowlist; Manager registration never grants administrative authority. */
function bootstrapAdminSessionIds(): string[] {
  return (process.env.TTR_ADMIN_SESSION_IDS ?? "").split(",").map(value => value.trim()).filter(Boolean);
}
const REQUESTER_CATEGORIES = [
  "request-reproduction", "request-logs", "request-access", "request-decision", "request-authority", "mitigation", "stop-change", "safe-to-proceed",
] as const;
const TTR_SUBCOMMANDS = [
  { value: "register", label: "register", description: "Register the active Manager for a domain" },
  { value: "status", label: "status", description: "Inspect a domain's active Manager" },
  { value: "list", label: "list", description: "Render Managers, aliases, and statuses" },
  { value: "unregister", label: "unregister", description: "Remove a domain or an entire Manager" },
  { value: "deactivate", label: "deactivate", description: "Deactivate a domain's Manager" },
  { value: "autoname", label: "autoname", description: "Opt in to guarded TTR session naming" },
] as const;

function json(value: unknown): { content: Array<{ type: "text"; text: string }>; details: unknown } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)));
  return rows.map(row => row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ")).join("\n");
}

function pocTable(pocs: PocListEntry[]): string {
  return table([["MANAGER", "DOMAIN", "ALIASES", "SESSION", "STATUS"], ...pocs.map(poc => [poc.managerName ?? "-", poc.domain, poc.aliases.filter(alias => alias !== poc.domain).join(", ") || "-", poc.sessionId, poc.active ? "active" : "inactive"])]);
}

function currentSessionId(ctx: ExtensionContext): string {
  const sessionId = ctx.sessionManager.getSessionId();
  if (!sessionId) throw new Error("Pi did not provide a current session ID; refusing to register or route a Manager");
  return sessionId;
}

function parseRegisterArgs(args: string, defaultDomain: string): { domains: string[]; sessionId?: string; replace: boolean; admin: boolean } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const domains: string[] = [];
  let sessionId: string | undefined;
  let replace = false;
  let admin = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--replace") {
      replace = true;
      continue;
    }
    if (token === "--admin") {
      admin = true;
      continue;
    }
    if (token === "--session-id") {
      sessionId = tokens[index + 1];
      if (!sessionId) throw new Error("Usage: /ttr register [domain] [aliases…] [--session-id <id>] [--replace]");
      index += 1;
      continue;
    }
    domains.push(token);
  }
  if (admin && (domains.length > 0 || replace)) throw new Error("Usage: /ttr register --admin [--session-id <id>]");
  return { domains: admin ? [] : (domains.length > 0 ? domains : [defaultDomain]), sessionId, replace, admin };
}

async function domainFromContext(pi: ExtensionAPI, cwd: string): Promise<string> {
  const root = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 10_000 });
  const directory = root.code === 0 && root.stdout.trim() ? root.stdout.trim() : cwd;
  const domain = basename(directory);
  if (!domain) throw new Error("Unable to derive a domain from the current directory; use /ttr <subcommand> <domain>");
  return domain;
}

function parseNameArgs(args: string): { action: "on" | "off" | "status" | "refresh"; force: boolean } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const force = tokens.includes("--force");
  const values = tokens.filter(token => token !== "--force");
  if (values.length !== 1 || !["on", "off", "status", "refresh"].includes(values[0]!)) throw new Error("Usage: /ttr autoname <on|off|status|refresh> [--force]");
  if (force && values[0] !== "refresh") throw new Error("--force is supported only by /ttr autoname refresh");
  return { action: values[0] as "on" | "off" | "status" | "refresh", force };
}

function parseDomain(args: string, defaultDomain: string, usage: string): string {
  const values = args.trim().split(/\s+/).filter(Boolean);
  if (values.length > 1) throw new Error(`Usage: ${usage}`);
  return values[0] ?? defaultDomain;
}

function parseUnregisterArgs(args: string, defaultDomain: string): { domain: string; all: boolean; admin: boolean } {
  const values = args.trim().split(/\s+/).filter(Boolean);
  const all = values.includes("--all");
  const admin = values.includes("--admin");
  const domains = values.filter(value => value !== "--all" && value !== "--admin");
  if (domains.length > 1 || (admin && (all || domains.length !== 1))) throw new Error("Usage: /ttr unregister [domain] [--all] | /ttr unregister <session-id> --admin");
  return { domain: domains[0] ?? defaultDomain, all, admin };
}

function parseStatusArgs(args: string, defaultDomain: string): { domain: string; json: boolean } {
  const values = args.trim().split(/\s+/).filter(Boolean);
  const json = values.includes("--json");
  const domains = values.filter(value => value !== "--json");
  if (domains.length > 1) throw new Error("Usage: /ttr status [domain] [--json]");
  return { domain: domains[0] ?? defaultDomain, json };
}

function parseListArgs(args: string): { activeOnly: boolean; json: boolean; admin: boolean } {
  const values = args.trim().split(/\s+/).filter(Boolean);
  const activeOnly = values.includes("--active");
  const json = values.includes("--json");
  const admin = values.includes("--admin");
  if (values.some(value => !["--active", "--json", "--admin"].includes(value)) || (admin && activeOnly)) throw new Error("Usage: /ttr list [--active] [--json] [--admin]");
  return { activeOnly, json, admin };
}

function ttrArgumentCompletions(prefix: string) {
  const hasTrailingSpace = /\s$/.test(prefix);
  const tokens = prefix.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...TTR_SUBCOMMANDS];
  if (tokens.length === 1 && !hasTrailingSpace) {
    return TTR_SUBCOMMANDS.filter(item => item.value.startsWith(tokens[0]!));
  }
  if (tokens[0] === "autoname") {
    const current = hasTrailingSpace ? "" : tokens.at(-1)!;
    return [
      { value: "on", label: "on", description: "Enable guarded naming for this Pi session" },
      { value: "off", label: "off", description: "Disable naming for this Pi session" },
      { value: "status", label: "status", description: "Show naming status" },
      { value: "refresh", label: "refresh", description: "Refresh the name if TTR owns it" },
      { value: "--force", label: "--force", description: "Overwrite an explicit name when refreshing" },
    ].filter(item => item.value.startsWith(current));
  }
  if (tokens[0] === "list") {
    const current = hasTrailingSpace ? "" : tokens.at(-1)!;
    const items = [
      { value: "--active", label: "--active", description: "Show active Managers only" },
      { value: "--json", label: "--json", description: "Output JSON for an agent" },
      { value: "--admin", label: "--admin", description: "List enrolled admins" },
    ].filter(item => !tokens.includes(item.value) && item.value.startsWith(current));
    return items.length > 0 ? items : null;
  }
  if (tokens[0] === "status") {
    const current = hasTrailingSpace ? "" : tokens.at(-1)!;
    const items = [{ value: "--json", label: "--json", description: "Output JSON for an agent" }]
      .filter(item => !tokens.includes(item.value) && item.value.startsWith(current));
    return items.length > 0 ? items : null;
  }
  if (tokens[0] === "unregister") {
    const current = hasTrailingSpace ? "" : tokens.at(-1)!;
    const items = [
      { value: "--all", label: "--all", description: "Remove every domain for this Manager" },
      { value: "--admin", label: "--admin", description: "Revoke an enrolled admin" },
    ].filter(item => !tokens.includes(item.value) && item.value.startsWith(current));
    return items.length > 0 ? items : null;
  }
  if (tokens[0] !== "register") return null;
  const current = hasTrailingSpace ? "" : tokens.at(-1)!;
  const items = [
    { value: "--replace", label: "--replace", description: "Replace an active Manager explicitly" },
    { value: "--session-id", label: "--session-id", description: "Register an explicit Pi session ID" },
    { value: "--admin", label: "--admin", description: "Enroll an admin instead of a Manager" },
  ].filter(item => !tokens.includes(item.value) && item.value.startsWith(current));
  return items.length > 0 ? items : null;
}

export default function triageControlPlane(pi: ExtensionAPI) {
  const plane = new TriageControlPlane({
    statePath: STATE_PATH,
    git: async () => ({ clean: false }), // Tool calls override this with the actual cwd-aware inspector below.
    bootstrapAdminSessionIds: bootstrapAdminSessionIds(),
  });
  const syncSessionName = async (ctx: ExtensionContext, force = false): Promise<boolean> => {
    const sessionId = currentSessionId(ctx);
    if (!await plane.isSessionNamingEnabled(sessionId)) return false;
    const poc = (await plane.listPocs()).find(record => record.active && record.sessionId === sessionId);
    if (!poc) return false;
    const desired = `ttr: ${poc.canonicalDomain ?? poc.domain}`;
    const current = pi.getSessionName?.() ?? ctx.sessionManager.getSessionName?.();
    if (current && current !== desired && !force) return false;
    if (current !== desired) pi.setSessionName(desired);
    return true;
  };
  const afterTtrActivity = async <T>(ctx: ExtensionContext, action: () => Promise<T>): Promise<T> => {
    await syncSessionName(ctx);
    return action();
  };
  const withGit = (cwd: string) => new TriageControlPlane({
    statePath: STATE_PATH,
    git: async () => {
      const status = await pi.exec("git", ["status", "--porcelain"], { cwd, timeout: 10_000 });
      const head = await pi.exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 10_000 });
      return { clean: status.code === 0 && status.stdout.trim() === "", ...(head.code === 0 ? { head: head.stdout.trim() } : {}) };
    },
  });

  pi.registerCommand("ttr", {
    description: "TTR control plane: register, status, list, unregister, deactivate, or autoname. Domains default to the current repository name.",
    getArgumentCompletions: ttrArgumentCompletions,
    handler: async (args, ctx) => {
      const [subcommand = "", ...rest] = (args || "").trim().split(/\s+/).filter(Boolean);
      const subcommandArgs = rest.join(" ");

      if (subcommand === "register") {
        const input = parseRegisterArgs(subcommandArgs, await domainFromContext(pi, ctx.cwd));
        const activeSessionId = currentSessionId(ctx);
        if (input.admin) {
          const admin = await plane.registerAdmin(input.sessionId ?? activeSessionId, activeSessionId);
          ctx.ui.notify(`TTR admin registered: ${admin.sessionId}`, "info");
          return;
        }
        const records = await plane.registerPocs(input.domains, { sessionId: input.sessionId ?? activeSessionId, projectBoundary: ctx.cwd }, input.replace);
        // TTR registration is a channel publisher only for the active trace it can append to.
        if (records.some(record => record.sessionId === activeSessionId)) {
          pi.appendEntry("pi-channel", { version: 1, op: "join", channel: "ttr", source: "ttr" });
        }
        await syncSessionName(ctx);
        ctx.ui.notify(`TTR Manager registered: ${records.map(record => record.domain).join(", ")} → ${records[0]!.sessionId}`, "info");
        return;
      }
      if (subcommand === "autoname") {
        const { action, force } = parseNameArgs(subcommandArgs);
        const sessionId = currentSessionId(ctx);
        if (action === "on" || action === "off") await plane.setSessionNaming(sessionId, action === "on");
        const updated = action === "on" || action === "refresh" ? await syncSessionName(ctx, force) : false;
        const enabled = await plane.isSessionNamingEnabled(sessionId);
        ctx.ui.notify(`TTR session naming: ${enabled ? "on" : "off"}${updated ? " (updated)" : ""}`, "info");
        return;
      }
      if (subcommand === "status" || subcommand === "manager" || subcommand === "poc") {
        const input = parseStatusArgs(subcommandArgs, await domainFromContext(pi, ctx.cwd));
        const manager = await plane.resolvePoc(input.domain);
        ctx.ui.notify(input.json ? JSON.stringify(manager, null, 2) : pocTable(manager ? [{ ...manager, aliases: [] }] : []), "info");
        await syncSessionName(ctx);
        return;
      }
      if (subcommand === "pocs") {
        if (subcommandArgs) throw new Error("Usage: /ttr pocs");
        ctx.ui.notify(JSON.stringify(await plane.listPocs(), null, 2), "info");
        await syncSessionName(ctx);
        return;
      }
      if (subcommand === "list") {
        const { activeOnly, json: jsonOutput, admin } = parseListArgs(subcommandArgs);
        if (admin) {
          const records = await plane.listAdmins(currentSessionId(ctx));
          ctx.ui.notify(jsonOutput ? JSON.stringify(records, null, 2) : table([["ADMIN", "SESSION", "STATUS"], ...records.map(record => ["admin", record.sessionId, record.active ? "active" : "inactive"])]), "info");
        } else {
          const records = await plane.listPocs(!activeOnly);
          ctx.ui.notify(jsonOutput ? JSON.stringify(records, null, 2) : pocTable(records), "info");
        }
        await syncSessionName(ctx);
        return;
      }
      if (subcommand === "unregister") {
        const input = parseUnregisterArgs(subcommandArgs, await domainFromContext(pi, ctx.cwd));
        if (input.admin) {
          const admin = await plane.deactivateAdmin(input.domain, currentSessionId(ctx));
          ctx.ui.notify(`TTR admin unregistered: ${admin.sessionId}`, "info");
          return;
        }
        const result = await plane.unregisterPoc(input.domain, input.all, currentSessionId(ctx));
        ctx.ui.notify(`TTR Manager ${input.all ? "unregistered" : "domain unregistered"}: ${result.removedDomains.join(", ")}`, "info");
        await syncSessionName(ctx);
        return;
      }
      if (subcommand === "deactivate") {
        const domain = parseDomain(subcommandArgs, await domainFromContext(pi, ctx.cwd), "/ttr deactivate [domain]");
        const record = await plane.deactivatePoc(domain, currentSessionId(ctx));
        ctx.ui.notify(`TTR Manager deactivated: ${record.domain}`, "info");
        await syncSessionName(ctx);
        return;
      }
      throw new Error("Usage: /ttr <register|status|list|unregister|deactivate|autoname> [domain]");
    },
  });

  pi.registerTool({
    name: "ttr_intake", label: "TTR Intake", description: "Record a defect with explicit source, owning domain, and addressed Manager. A receiver is authoritative only when all three routing assertions agree.",
    promptSnippet: "Record a defect with sourceDomain, ownerDomain, and targetPocSessionId (the target Manager) before diagnosis or writer work.",
    promptGuidelines: ["Use ttr_intake before diagnosis, subagent lanes, implementation, review, validation, deployment, or requester messaging for a defect.", "Never infer ownerDomain from sourceDomain or a sender workspace; resolve it through the TTR Manager registry."],
    parameters: Type.Object({ reporter: Type.String(), source: Type.String(), sourceDomain: Type.String(), ownerDomain: Type.String(), targetPocSessionId: Type.String(), symptom: Type.String(), impact: Type.String(), environment: Type.String(), reproduction: Type.String(), evidenceReferences: Type.Array(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await afterTtrActivity(ctx, () => plane.intake({ ...params, currentSessionId: currentSessionId(ctx) }));
      return json({ ...result, handoff: result.handoff ? { ...result.handoff, senderContract: `Use only an established channel after confirming the Manager is reachable: intercom({ action: \"send\", to: ${JSON.stringify(result.handoff.targetSessionId)}, message: ${JSON.stringify(JSON.stringify(result.handoff.payload))} })` } : undefined });
    },
  });

  pi.registerTool({
    name: "ttr_intake_for_owner", label: "TTR Intake for Owner", description: "Record a defect with explicit source and owner domains, resolving the active owner Manager atomically. Fails if the owner has no active Manager.",
    promptSnippet: "Record a defect with sourceDomain and ownerDomain before diagnosis or writer work; TTR resolves the active owner Manager.",
    promptGuidelines: ["Use ttr_intake_for_owner before diagnosis, subagent lanes, implementation, review, validation, deployment, or requester messaging for a defect.", "Never infer ownerDomain from sourceDomain or a sender workspace; resolve it through the TTR Manager registry."],
    parameters: Type.Object({ reporter: Type.String(), source: Type.String(), sourceDomain: Type.String(), ownerDomain: Type.String(), symptom: Type.String(), impact: Type.String(), environment: Type.String(), reproduction: Type.String(), evidenceReferences: Type.Array(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await afterTtrActivity(ctx, () => plane.intakeForOwner({ ...params, currentSessionId: currentSessionId(ctx) }));
      return json({ ...result, handoff: result.handoff ? { ...result.handoff, senderContract: `Use only an established channel after confirming the Manager is reachable: intercom({ action: \"send\", to: ${JSON.stringify(result.handoff.targetSessionId)}, message: ${JSON.stringify(JSON.stringify(result.handoff.payload))} })` } : undefined });
    },
  });

  pi.registerTool({
    name: "ttr_reattest_defect_authority", label: "Re-attest Defect Authority", description: "Explicitly re-attest a legacy defect's source, owner, and target Manager routing. Only the active owner Manager addressed by targetPocSessionId may perform this one-time migration.",
    parameters: Type.Object({ defectId: Type.String(), sourceDomain: Type.String(), ownerDomain: Type.String(), targetPocSessionId: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      return json(await plane.reattestDefectAuthority(params.defectId, { ...params, actorSessionId: currentSessionId(ctx) }));
    },
  });

  pi.registerTool({
    name: "ttr_assign_work_item", label: "Assign Authoritative Work Item", description: "Assign the one authoritative work item and its explicitly configured repository lifecycle to a tracked defect.",
    parameters: Type.Object({ defectId: Type.String(), workItemId: Type.String(), workItemPath: Type.String(), status: Type.String(), lifecycleStates: Type.Array(Type.String()), adapter: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) { return json(await afterTtrActivity(ctx, () => plane.assignWorkItem(params.defectId, { id: params.workItemId, path: params.workItemPath, status: params.status, lifecycleStates: params.lifecycleStates, adapter: params.adapter }, currentSessionId(ctx)))); },
  });
  pi.registerTool({
    name: "ttr_reassign_work_item", label: "Reassign Authoritative Work Item", description: "Replace an authoritative work item only as the active, addressed owner Manager. The prior item is retained in immutable audit history with a required reason and evidence references.",
    parameters: Type.Object({ defectId: Type.String(), workItemId: Type.String(), workItemPath: Type.String(), status: Type.String(), lifecycleStates: Type.Array(Type.String()), adapter: Type.Optional(Type.String()), reason: Type.String(), evidenceReferences: Type.Array(Type.String(), { minItems: 1 }) }),
    async execute(_id, params, _signal, _update, ctx) {
      return json(await plane.reassignWorkItem(params.defectId, { id: params.workItemId, path: params.workItemPath, status: params.status, lifecycleStates: params.lifecycleStates, adapter: params.adapter }, { reason: params.reason, evidenceReferences: params.evidenceReferences }, currentSessionId(ctx)));
    },
  });
  pi.registerTool({
    name: "ttr_register_admin", label: "Register TTR Admin", description: "Enroll an explicit TTR admin. The first admin must be named in TTR_ADMIN_SESSION_IDS; later enrollment requires an active admin.",
    parameters: Type.Object({ sessionId: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) { return json(await plane.registerAdmin(params.sessionId, currentSessionId(ctx))); },
  });
  pi.registerTool({
    name: "ttr_deactivate_admin", label: "Deactivate TTR Admin", description: "An active TTR admin permanently deactivates another enrolled admin; inactive records cannot be reactivated.",
    parameters: Type.Object({ sessionId: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) { return json(await plane.deactivateAdmin(params.sessionId, currentSessionId(ctx))); },
  });
  pi.registerTool({
    name: "ttr_admin_lookup", label: "TTR Admin Lookup", description: "Inspect all defects, Managers, assignment histories, and computed orphan state. Requires explicit active-admin authority.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) { return json(await plane.adminLookup(currentSessionId(ctx))); },
  });
  pi.registerTool({
    name: "ttr_mark_poc_assignment_orphaned", label: "Mark Manager Assignment Orphaned", description: "An active TTR admin marks one defect Manager assignment orphaned with required reason and evidence; original ownership history remains retained.",
    parameters: Type.Object({ defectId: Type.String(), reason: Type.String(), evidenceReferences: Type.Array(Type.String(), { minItems: 1 }) }),
    async execute(_id, params, _signal, _update, ctx) { return json(await plane.markPocAssignmentOrphaned(params.defectId, { reason: params.reason, evidenceReferences: params.evidenceReferences }, currentSessionId(ctx))); },
  });
  pi.registerTool({
    name: "ttr_admin_rebind_work_item", label: "Admin Rebind Authoritative Work Item", description: "An active TTR admin rebinds a defect to a replacement work item at its explicit path and the active Manager session for that domain; ID, path, lifecycle, and collisions are validated.",
    parameters: Type.Object({ defectId: Type.String(), targetPocSessionId: Type.String(), workItemId: Type.String(), workItemPath: Type.String(), status: Type.String(), lifecycleStates: Type.Array(Type.String()), adapter: Type.Optional(Type.String()), reason: Type.String(), evidenceReferences: Type.Array(Type.String(), { minItems: 1 }) }),
    async execute(_id, params, _signal, _update, ctx) {
      return json(await plane.adminRebindWorkItem(params.defectId, { id: params.workItemId, path: params.workItemPath, status: params.status, lifecycleStates: params.lifecycleStates, adapter: params.adapter }, { targetPocSessionId: params.targetPocSessionId, reason: params.reason, evidenceReferences: params.evidenceReferences }, currentSessionId(ctx)));
    },
  });
  pi.registerTool({
    name: "ttr_supersede_work_item", label: "Supersede Authoritative Work Item", description: "An active TTR admin creates a traceable successor for an obsolete authoritative item without deleting the original audit history.",
    parameters: Type.Object({ defectId: Type.String(), workItemId: Type.String(), workItemPath: Type.String(), status: Type.String(), lifecycleStates: Type.Array(Type.String()), adapter: Type.Optional(Type.String()), reason: Type.String(), evidenceReferences: Type.Array(Type.String(), { minItems: 1 }) }),
    async execute(_id, params, _signal, _update, ctx) {
      return json(await plane.supersedeWorkItem(params.defectId, { id: params.workItemId, path: params.workItemPath, status: params.status, lifecycleStates: params.lifecycleStates, adapter: params.adapter }, { reason: params.reason, evidenceReferences: params.evidenceReferences }, currentSessionId(ctx)));
    },
  });
  pi.registerTool({
    name: "ttr_transition_work_item", label: "Transition Work Item", description: "Record an authoritative work-item transition using only its configured lifecycle status; blockers and next action remain separate fields.",
    parameters: Type.Object({ defectId: Type.String(), status: Type.String(), blocker: Type.Optional(Type.String()), nextAction: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) { return json(await afterTtrActivity(ctx, () => plane.transitionWorkItem(params.defectId, params.status, { blocker: params.blocker, nextAction: params.nextAction }))); },
  });
  pi.registerTool({
    name: "ttr_prepare_work_lane", label: "Prepare TTR Work Lane", description: "Produce the mandatory authoritative-work-item reference for a diagnosis, review, validation, or implementation lane. Use this before launching a supported work lane.",
    parameters: Type.Object({ defectId: Type.String(), lane: StringEnum(["tracking", "diagnosis", "review", "validation", "implementation"] as const) }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await afterTtrActivity(ctx, async () => {
        const defect = await plane.ensurePocAuthority(params.defectId, currentSessionId(ctx));
        if (!defect?.workItem) throw new Error(`Cannot prepare ${params.lane} lane: defect has no authoritative work item`);
        return { defectId: defect.id, lane: params.lane, workItem: defect.workItem, requiredTaskPreamble: `Authoritative defect work item: ${defect.workItem.id} (${defect.workItem.path}). Link all artifacts, findings, and status updates to this work item. Do not create another work item.` };
      });
      return json(result);
    },
  });
  pi.registerTool({
    name: "ttr_record_evidence", label: "Record TTR Evidence", description: "Link validation, review, or other evidence to the authoritative defect work item.",
    parameters: Type.Object({ defectId: Type.String(), type: StringEnum(["validation", "review", "other"] as const), status: StringEnum(["passed", "failed", "recorded"] as const), path: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) { return json(await afterTtrActivity(ctx, () => plane.recordEvidence(params.defectId, params))); },
  });
  pi.registerTool({
    name: "ttr_record_commit_evidence", label: "Record Commit Evidence", description: "Record the exact commit SHA only in linked commit evidence, never on the work item itself.",
    parameters: Type.Object({ defectId: Type.String(), sha: Type.String(), phase: StringEnum(["pre-deployment", "post-deployment", "other"] as const), path: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) { return json(await afterTtrActivity(ctx, () => plane.recordCommitEvidence(params.defectId, params))); },
  });
  pi.registerTool({
    name: "ttr_record_deployment_evidence", label: "Record Deployment Evidence", description: "Record an already-authorized deployment's artifact/version, receipt, and healthy verification. This tool never deploys.",
    parameters: Type.Object({ defectId: Type.String(), artifact: Type.String(), receipt: Type.String(), verification: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) { return json(await afterTtrActivity(ctx, () => plane.recordDeploymentEvidence(params.defectId, params))); },
  });
  pi.registerTool({
    name: "ttr_check_release_gate", label: "Check Release Gate", description: "Fail closed before a supported safe-to-proceed message: checks work item, clean Git tree, linked commit/validation/review evidence, and deployment finalization when required. It never deploys or publishes.",
    parameters: Type.Object({ defectId: Type.String(), deploymentRequired: Type.Boolean() }),
    async execute(_id, params, _signal, _update, ctx) { return json(await afterTtrActivity(ctx, () => withGit(ctx.cwd).checkReleaseGate(params.defectId, { deploymentRequired: params.deploymentRequired }))); },
  });
  const requesterTool = (name: "ttr_requester_message" | "ttr_send_requester_message", label: string) => pi.registerTool({
    name, label, description: "Validate and record an allowed requester-facing message as evidence. It does not contact any external channel; delivery remains a separately authorized, established-channel action.",
    parameters: Type.Object({ defectId: Type.String(), category: StringEnum(REQUESTER_CATEGORIES), message: Type.String(), deploymentRequired: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const activePlane = params.category === "safe-to-proceed" ? withGit(ctx.cwd) : plane;
      const evidence = await afterTtrActivity(ctx, () => activePlane.recordRequesterMessage(params.defectId, params.category as RequesterMessageCategory, params.message, { deploymentRequired: params.deploymentRequired }));
      return json({ evidence, delivery: "not-performed", boundary: "Use the established requester channel only after independent authorization; this extension has no external transport." });
    },
  });
  requesterTool("ttr_requester_message", "Record Requester Message");
  requesterTool("ttr_send_requester_message", "Guarded Requester Message");
}
