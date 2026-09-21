import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadModule() { process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "ttr-command-state-")); process.env.TTR_ADMIN_SESSION_IDS = "admin"; return import(`../extensions/triage-control-plane/index.ts?test=${Date.now()}-${Math.random()}`); }
async function loadExtension() { return (await loadModule()).default; }
function setup(sessionId = "manager", sessionName = "Manager session") { const commands = new Map(), tools = new Map(), notifications = []; return { commands, tools, notifications, api: { getSessionName: () => sessionName, on() {}, registerCommand(name, spec) { commands.set(name, spec); }, registerTool(spec) { tools.set(spec.name, spec); }, async exec(command, args) { if (args.includes("--show-toplevel")) return { code: 0, stdout: "/repo/payments\n" }; if (args[0] === "status") return { code: 0, stdout: "" }; return { code: 0, stdout: "head" }; } }, context: { cwd: "/repo/payments", sessionManager: { getSessionId: () => sessionId }, ui: { notify(message) { notifications.push(message); }, input: async () => undefined, select: async () => undefined } } }; }
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

test("/ttr status without a domain renders every registration for the current session", async () => {
  const extension = await loadExtension(); const { api, commands, context, notifications } = setup("manager", "Risk manager session"); extension(api);
  await commands.get("ttr").handler("register risk", context);

  await commands.get("ttr").handler("status", context);
  assert.match(notifications.at(-1), /^MANAGER\s+DOMAIN\s+ALIASES\s+SESSION\s+STATUS/m);
  assert.match(notifications.at(-1), /risk/);
  assert.match(notifications.at(-1), /Risk manager session/);
});

test("/ttr status reports an unmatched domain instead of an empty table", async () => {
  const extension = await loadExtension(); const { api, commands, context, notifications } = setup(); extension(api);

  await commands.get("ttr").handler("status unknown-domain", context);
  assert.equal(notifications.at(-1), "No active Manager registered for unknown-domain");
});

test("/ttr list --admin renders an admin table without implying Manager names are session IDs", async () => {
  const extension = await loadExtension(); const { api, commands, context, notifications } = setup("admin"); extension(api);
  await commands.get("ttr").handler("register payments", context);
  await commands.get("ttr").handler("register --admin", context);

  await commands.get("ttr").handler("list --admin", context);
  assert.match(notifications.at(-1), /^MANAGER\s+DOMAIN\s+SESSION\s+STATUS/m);
  assert.match(notifications.at(-1), /admin/);
  assert.doesNotMatch(notifications.at(-1), /^\s*\[/);
});

test("list selection resumes a selected registered Pi session", async () => {
  const { selectTtrSession } = await loadModule(); const selected = [], context = { ui: { notify() {}, select: async () => selected.shift() }, switchSession: async path => { context.path = path; } };
  selected.push("Payments work — payments [manager]", "Resume as current session");
  await selectTtrSession(context, [{ domain: "payments", aliases: [], sessionId: "manager", active: true }], async () => [{ id: "manager", name: "Payments work", path: "/sessions/manager.jsonl" }]);
  assert.equal(context.path, "/sessions/manager.jsonl");
});

test("restore opens registered persisted sessions in a stacked ttr Zellij tab", async () => {
  const { restoreTtrSessions } = await loadModule(); const calls = [], notifications = [], previous = { session: process.env.ZELLIJ_SESSION_NAME, pane: process.env.ZELLIJ_PANE_ID }; process.env.ZELLIJ_SESSION_NAME = "workspace"; process.env.ZELLIJ_PANE_ID = "1";
  try {
    await restoreTtrSessions({}, { cwd: "/fallback", ui: { notify(message) { notifications.push(message); } } }, [{ domain: "payments", aliases: [], sessionId: "payments", active: true }, { domain: "risk", aliases: [], sessionId: "risk", active: true }], async () => [{ id: "payments", name: "Payments", path: "/sessions/payments.jsonl", cwd: "/repo/payments" }, { id: "risk", name: "Risk", path: "/sessions/risk.jsonl", cwd: "/repo/risk" }], async args => { calls.push(args); return args.includes("new-tab") ? { code: 0, stdout: "7\n", stderr: "" } : { code: 0, stdout: "", stderr: "" }; });
  } finally { if (previous.session === undefined) delete process.env.ZELLIJ_SESSION_NAME; else process.env.ZELLIJ_SESSION_NAME = previous.session; if (previous.pane === undefined) delete process.env.ZELLIJ_PANE_ID; else process.env.ZELLIJ_PANE_ID = previous.pane; }
  assert.deepEqual(calls[0], ["action", "query-tab-names"]);
  assert.deepEqual(calls[1], ["action", "new-tab", "--name", "ttr", "--cwd", "/repo/payments", "--", "pi", "--session", "/sessions/payments.jsonl"]);
  assert.deepEqual(calls[2], ["action", "new-pane", "--tab-id", "7", "--cwd", "/repo/risk", "--name", "ttr: Risk", "--stacked", "--no-focus", "--", "pi", "--session", "/sessions/risk.jsonl"]);
  assert.match(notifications.at(-1), /Restored 2 TTR sessions/);
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
