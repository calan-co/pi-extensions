import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadExtension() { process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "ttr-command-state-")); process.env.TTR_ADMIN_SESSION_IDS = "admin"; return (await import(`../extensions/triage-control-plane/index.ts?test=${Date.now()}-${Math.random()}`)).default; }
function setup(sessionId = "manager") { const commands = new Map(), tools = new Map(), notifications = []; return { commands, tools, notifications, api: { registerCommand(name, spec) { commands.set(name, spec); }, registerTool(spec) { tools.set(spec.name, spec); }, async exec(command, args) { if (args[0] === "--show-toplevel") return { code: 0, stdout: "/repo/payments\n" }; if (args[0] === "status") return { code: 0, stdout: "" }; return { code: 0, stdout: "head" }; } }, context: { cwd: "/repo/payments", sessionManager: { getSessionId: () => sessionId }, ui: { notify(message) { notifications.push(message); }, input: async () => undefined, select: async () => undefined } } }; }
const intake = { reporter: "r", source: "s", sourceDomain: "storefront", coordinatorDomain: "payments", symptom: "x", impact: "high", environment: "prod", reproduction: "r", evidenceReferences: [] };

test("TTR exposes domain-scoped tools and derives current session internally", async () => {
  const extension = await loadExtension(); const { api, commands, tools, context } = setup(); extension(api);
  for (const name of ["ttr_intake", "ttr_intake_for_owner", "ttr_add_contributing_domains", "ttr_transfer_coordinator", "ttr_assign_work_item", "ttr_transition_work_item", "ttr_record_evidence", "ttr_check_release_gate"]) assert.ok(tools.has(name), name);
  await commands.get("ttr").handler("register payments", context);
  const result = await tools.get("ttr_intake_for_owner").execute("", intake, undefined, undefined, context);
  assert.equal(result.details.defect.coordinatorDomain, "payments");
  assert.equal(result.details.defect.report.sourceDomain, "storefront");
  assert.equal("ownerPocSessionId" in result.details.defect, false);
  assert.ok(result.details.defect.audit[0].actorSessionId);
});

test("transfer is available through UI and only calls the control plane through a current session", async () => {
  const extension = await loadExtension(); const manager = setup(); extension(manager.api);
  await manager.commands.get("ttr").handler("register payments", manager.context);
  const created = await manager.tools.get("ttr_intake_for_owner").execute("", intake, undefined, undefined, manager.context);
  const admin = setup("admin"); extension(admin.api);
  await admin.commands.get("ttr").handler("register risk", admin.context);
  await admin.tools.get("ttr_register_admin").execute("", { sessionId: "admin" }, undefined, undefined, admin.context);
  const values = ["Transfer coordinator (admin)", created.details.defect.id, "risk", "decision:1"];
  admin.context.ui.select = async () => values.shift(); admin.context.ui.input = async () => values.shift(); admin.context.ui.confirm = async () => true;
  await admin.commands.get("ttr").handler("ui", admin.context);
  const record = await admin.tools.get("ttr_admin_lookup").execute("", {}, undefined, undefined, admin.context);
  assert.equal(record.details.defects.find(item => item.id === created.details.defect.id).coordinatorDomain, "risk");
});
