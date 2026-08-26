import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { TriageControlPlane, type RequesterMessageCategory } from "./src/core.ts";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const STATE_PATH = join(AGENT_DIR, "triage-control-plane", "state.json");
const REQUESTER_CATEGORIES = [
  "request-reproduction", "request-logs", "request-access", "request-decision", "request-authority", "mitigation", "stop-change", "safe-to-proceed",
] as const;
const TTR_SUBCOMMANDS = [
  { value: "register", label: "register", description: "Register the active POC for a domain" },
  { value: "poc", label: "poc", description: "Inspect a domain's active POC" },
  { value: "pocs", label: "pocs", description: "List active POC registrations" },
  { value: "deactivate", label: "deactivate", description: "Deactivate a domain's POC" },
] as const;

function json(value: unknown): { content: Array<{ type: "text"; text: string }>; details: unknown } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
}

function currentSessionId(ctx: ExtensionContext): string {
  const sessionId = ctx.sessionManager.getSessionId();
  if (!sessionId) throw new Error("Pi did not provide a current session ID; refusing to register or route a POC");
  return sessionId;
}

function parseRegisterArgs(args: string, defaultDomain: string): { domains: string[]; sessionId?: string; replace: boolean } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const domains: string[] = [];
  let sessionId: string | undefined;
  let replace = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--replace") {
      replace = true;
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
  return { domains: domains.length > 0 ? domains : [defaultDomain], sessionId, replace };
}

async function domainFromContext(pi: ExtensionAPI, cwd: string): Promise<string> {
  const root = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 10_000 });
  const directory = root.code === 0 && root.stdout.trim() ? root.stdout.trim() : cwd;
  const domain = basename(directory);
  if (!domain) throw new Error("Unable to derive a domain from the current directory; use /ttr <subcommand> <domain>");
  return domain;
}

function parseDomain(args: string, defaultDomain: string, usage: string): string {
  const values = args.trim().split(/\s+/).filter(Boolean);
  if (values.length > 1) throw new Error(`Usage: ${usage}`);
  return values[0] ?? defaultDomain;
}

function ttrArgumentCompletions(prefix: string) {
  const hasTrailingSpace = /\s$/.test(prefix);
  const tokens = prefix.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...TTR_SUBCOMMANDS];
  if (tokens.length === 1 && !hasTrailingSpace) {
    return TTR_SUBCOMMANDS.filter(item => item.value.startsWith(tokens[0]!));
  }
  if (tokens[0] !== "register") return null;
  const current = hasTrailingSpace ? "" : tokens.at(-1)!;
  const items = [
    { value: "--replace", label: "--replace", description: "Replace an active POC explicitly" },
    { value: "--session-id", label: "--session-id", description: "Register an explicit Pi session ID" },
  ].filter(item => !tokens.includes(item.value) && item.value.startsWith(current));
  return items.length > 0 ? items : null;
}

export default function triageControlPlane(pi: ExtensionAPI) {
  const plane = new TriageControlPlane({
    statePath: STATE_PATH,
    git: async () => ({ clean: false }), // Tool calls override this with the actual cwd-aware inspector below.
  });
  const withGit = (cwd: string) => new TriageControlPlane({
    statePath: STATE_PATH,
    git: async () => {
      const status = await pi.exec("git", ["status", "--porcelain"], { cwd, timeout: 10_000 });
      const head = await pi.exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 10_000 });
      return { clean: status.code === 0 && status.stdout.trim() === "", ...(head.code === 0 ? { head: head.stdout.trim() } : {}) };
    },
  });

  pi.registerCommand("ttr", {
    description: "TTR control plane: register, poc, pocs, or deactivate. Domains default to the current repository name.",
    getArgumentCompletions: ttrArgumentCompletions,
    handler: async (args, ctx) => {
      const [subcommand = "", ...rest] = (args || "").trim().split(/\s+/).filter(Boolean);
      const subcommandArgs = rest.join(" ");

      if (subcommand === "register") {
        const input = parseRegisterArgs(subcommandArgs, await domainFromContext(pi, ctx.cwd));
        const records = await plane.registerPocs(input.domains, { sessionId: input.sessionId ?? currentSessionId(ctx), projectBoundary: ctx.cwd }, input.replace);
        pi.setSessionName(`ttr: ${records[0]!.domain}`);
        ctx.ui.notify(`TTR POC registered: ${records.map(record => record.domain).join(", ")} → ${records[0]!.sessionId}`, "info");
        return;
      }
      if (subcommand === "poc") {
        const domain = parseDomain(subcommandArgs, await domainFromContext(pi, ctx.cwd), "/ttr poc [domain]");
        ctx.ui.notify(JSON.stringify(await plane.resolvePoc(domain), null, 2), "info");
        return;
      }
      if (subcommand === "pocs") {
        if (subcommandArgs) throw new Error("Usage: /ttr pocs");
        ctx.ui.notify(JSON.stringify(await plane.listPocs(), null, 2), "info");
        return;
      }
      if (subcommand === "deactivate") {
        const domain = parseDomain(subcommandArgs, await domainFromContext(pi, ctx.cwd), "/ttr deactivate [domain]");
        const record = await plane.deactivatePoc(domain);
        ctx.ui.notify(`TTR POC deactivated: ${record.domain}`, "info");
        return;
      }
      throw new Error("Usage: /ttr <register|poc|pocs|deactivate> [domain]");
    },
  });

  pi.registerTool({
    name: "ttr_intake", label: "TTR Intake", description: "Record a defect with explicit source, owning domain, and addressed POC. A receiver is authoritative only when all three routing assertions agree.",
    promptSnippet: "Record a defect with sourceDomain, ownerDomain, and targetPocSessionId before diagnosis or writer work.",
    promptGuidelines: ["Use ttr_intake before diagnosis, subagent lanes, implementation, review, validation, deployment, or requester messaging for a defect.", "Never infer ownerDomain from sourceDomain or a sender workspace; resolve it through the TTR POC registry."],
    parameters: Type.Object({ reporter: Type.String(), source: Type.String(), sourceDomain: Type.String(), ownerDomain: Type.String(), targetPocSessionId: Type.String(), symptom: Type.String(), impact: Type.String(), environment: Type.String(), reproduction: Type.String(), evidenceReferences: Type.Array(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await plane.intake({ ...params, currentSessionId: currentSessionId(ctx) });
      return json({ ...result, handoff: result.handoff ? { ...result.handoff, senderContract: `Use only an established channel after confirming the POC is reachable: intercom({ action: \"send\", to: ${JSON.stringify(result.handoff.targetSessionId)}, message: ${JSON.stringify(JSON.stringify(result.handoff.payload))} })` } : undefined });
    },
  });

  pi.registerTool({
    name: "ttr_reattest_defect_authority", label: "Re-attest Defect Authority", description: "Explicitly re-attest a legacy defect's source, owner, and target POC routing. Only the active owner POC addressed by targetPocSessionId may perform this one-time migration.",
    parameters: Type.Object({ defectId: Type.String(), sourceDomain: Type.String(), ownerDomain: Type.String(), targetPocSessionId: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      return json(await plane.reattestDefectAuthority(params.defectId, { ...params, actorSessionId: currentSessionId(ctx) }));
    },
  });

  pi.registerTool({
    name: "ttr_assign_work_item", label: "Assign Authoritative Work Item", description: "Assign the one authoritative work item and its explicitly configured repository lifecycle to a tracked defect.",
    parameters: Type.Object({ defectId: Type.String(), workItemId: Type.String(), workItemPath: Type.String(), status: Type.String(), lifecycleStates: Type.Array(Type.String()), adapter: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) { return json(await plane.assignWorkItem(params.defectId, { id: params.workItemId, path: params.workItemPath, status: params.status, lifecycleStates: params.lifecycleStates, adapter: params.adapter }, currentSessionId(ctx))); },
  });
  pi.registerTool({
    name: "ttr_reassign_work_item", label: "Reassign Authoritative Work Item", description: "Replace an authoritative work item only as the active, addressed owner POC. The prior item is retained in immutable audit history with a required reason and evidence references.",
    parameters: Type.Object({ defectId: Type.String(), workItemId: Type.String(), workItemPath: Type.String(), status: Type.String(), lifecycleStates: Type.Array(Type.String()), adapter: Type.Optional(Type.String()), reason: Type.String(), evidenceReferences: Type.Array(Type.String(), { minItems: 1 }) }),
    async execute(_id, params, _signal, _update, ctx) {
      return json(await plane.reassignWorkItem(params.defectId, { id: params.workItemId, path: params.workItemPath, status: params.status, lifecycleStates: params.lifecycleStates, adapter: params.adapter }, { reason: params.reason, evidenceReferences: params.evidenceReferences }, currentSessionId(ctx)));
    },
  });
  pi.registerTool({
    name: "ttr_transition_work_item", label: "Transition Work Item", description: "Record an authoritative work-item transition using only its configured lifecycle status; blockers and next action remain separate fields.",
    parameters: Type.Object({ defectId: Type.String(), status: Type.String(), blocker: Type.Optional(Type.String()), nextAction: Type.Optional(Type.String()) }),
    async execute(_id, params) { return json(await plane.transitionWorkItem(params.defectId, params.status, { blocker: params.blocker, nextAction: params.nextAction })); },
  });
  pi.registerTool({
    name: "ttr_prepare_work_lane", label: "Prepare TTR Work Lane", description: "Produce the mandatory authoritative-work-item reference for a diagnosis, review, validation, or implementation lane. Use this before launching a supported work lane.",
    parameters: Type.Object({ defectId: Type.String(), lane: StringEnum(["tracking", "diagnosis", "review", "validation", "implementation"] as const) }),
    async execute(_id, params, _signal, _update, ctx) {
      const defect = await plane.ensurePocAuthority(params.defectId, currentSessionId(ctx));
      if (!defect?.workItem) throw new Error(`Cannot prepare ${params.lane} lane: defect has no authoritative work item`);
      return json({ defectId: defect.id, lane: params.lane, workItem: defect.workItem, requiredTaskPreamble: `Authoritative defect work item: ${defect.workItem.id} (${defect.workItem.path}). Link all artifacts, findings, and status updates to this work item. Do not create another work item.` });
    },
  });
  pi.registerTool({
    name: "ttr_record_evidence", label: "Record TTR Evidence", description: "Link validation, review, or other evidence to the authoritative defect work item.",
    parameters: Type.Object({ defectId: Type.String(), type: StringEnum(["validation", "review", "other"] as const), status: StringEnum(["passed", "failed", "recorded"] as const), path: Type.Optional(Type.String()) }),
    async execute(_id, params) { return json(await plane.recordEvidence(params.defectId, params)); },
  });
  pi.registerTool({
    name: "ttr_record_commit_evidence", label: "Record Commit Evidence", description: "Record the exact commit SHA only in linked commit evidence, never on the work item itself.",
    parameters: Type.Object({ defectId: Type.String(), sha: Type.String(), phase: StringEnum(["pre-deployment", "post-deployment", "other"] as const), path: Type.String() }),
    async execute(_id, params) { return json(await plane.recordCommitEvidence(params.defectId, params)); },
  });
  pi.registerTool({
    name: "ttr_record_deployment_evidence", label: "Record Deployment Evidence", description: "Record an already-authorized deployment's artifact/version, receipt, and healthy verification. This tool never deploys.",
    parameters: Type.Object({ defectId: Type.String(), artifact: Type.String(), receipt: Type.String(), verification: Type.String() }),
    async execute(_id, params) { return json(await plane.recordDeploymentEvidence(params.defectId, params)); },
  });
  pi.registerTool({
    name: "ttr_check_release_gate", label: "Check Release Gate", description: "Fail closed before a supported safe-to-proceed message: checks work item, clean Git tree, linked commit/validation/review evidence, and deployment finalization when required. It never deploys or publishes.",
    parameters: Type.Object({ defectId: Type.String(), deploymentRequired: Type.Boolean() }),
    async execute(_id, params, _signal, _update, ctx) { return json(await withGit(ctx.cwd).checkReleaseGate(params.defectId, { deploymentRequired: params.deploymentRequired })); },
  });
  const requesterTool = (name: "ttr_requester_message" | "ttr_send_requester_message", label: string) => pi.registerTool({
    name, label, description: "Validate and record an allowed requester-facing message as evidence. It does not contact any external channel; delivery remains a separately authorized, established-channel action.",
    parameters: Type.Object({ defectId: Type.String(), category: StringEnum(REQUESTER_CATEGORIES), message: Type.String(), deploymentRequired: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const activePlane = params.category === "safe-to-proceed" ? withGit(ctx.cwd) : plane;
      const evidence = await activePlane.recordRequesterMessage(params.defectId, params.category as RequesterMessageCategory, params.message, { deploymentRequired: params.deploymentRequired });
      return json({ evidence, delivery: "not-performed", boundary: "Use the established requester channel only after independent authorization; this extension has no external transport." });
    },
  });
  requesterTool("ttr_requester_message", "Record Requester Message");
  requesterTool("ttr_send_requester_message", "Guarded Requester Message");
}
