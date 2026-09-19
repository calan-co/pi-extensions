import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadExtension(adminSessionIds = "") {
  process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "ttr-command-state-"));
  process.env.TTR_ADMIN_SESSION_IDS = adminSessionIds;
  return (await import(`../extensions/triage-control-plane/index.ts?test=${Date.now()}-${Math.random()}`)).default;
}

function setupApi(sessionId = "session-123") {
  const commands = new Map();
  const tools = new Map();
  const notifications = [];
  const appendedEntries = [];
  const sessionNames = [];
  let sessionName;
  return {
    commands,
    tools,
    notifications,
    appendedEntries,
    sessionNames,
    setSessionName(name) { sessionName = name; },
    api: {
      appendEntry(customType, data) { appendedEntries.push({ customType, data }); },
      registerCommand(name, spec) { commands.set(name, spec); },
registerTool(spec) { tools.set(spec.name, spec); },
      getSessionName() { return sessionName; },
      setSessionName(name) { sessionNames.push(name); sessionName = name; },
      async exec(command, args) {
        assert.equal(command, "git");
        assert.deepEqual(args, ["rev-parse", "--show-toplevel"]);
        return { code: 0, stdout: "/repos/payments\n", stderr: "" };
      },
    },
    context: {
      cwd: "/repos/payments/src",
      sessionManager: { getSessionId: () => sessionId },
      ui: { notify(message, level) { notifications.push({ message, level }); } },
    },
  };
}

test("/ttr register records a canonical domain and every supplied alias", async () => {
  const triageControlPlane = await loadExtension();
const { api, appendedEntries, commands, tools, notifications, sessionNames, context } = setupApi();
  triageControlPlane(api);

  assert.ok(tools.has("ttr_reassign_work_item"));
  assert.ok(tools.has("ttr_intake_for_owner"));
  assert.ok(tools.has("ttr_deactivate_admin"));
  assert.ok(tools.has("ttr_admin_lookup"));
  assert.ok(tools.has("ttr_mark_poc_assignment_orphaned"));
  assert.ok(tools.has("ttr_admin_rebind_work_item"));
  assert.ok(tools.has("ttr_supersede_work_item"));
  await commands.get("ttr").handler("register pi-extensions ttr agent-workflows handoff", context);
  await commands.get("ttr").handler("status handoff --json", context);

  assert.deepEqual(appendedEntries, [
    { customType: "pi-channel", data: { version: 1, op: "join", channel: "ttr", source: "ttr" } },
  ]);
  assert.deepEqual(sessionNames, []);
  assert.equal(notifications[0].message, "TTR Manager registered: pi-extensions, ttr, agent-workflows, handoff → session-123");
  assert.equal(JSON.parse(notifications[1].message).sessionId, "session-123");
});

test("/ttr list renders aliases once with the shared POC status", async () => {
  const triageControlPlane = await loadExtension();
  const { api, commands, notifications, context } = setupApi();
  triageControlPlane(api);
  await commands.get("ttr").handler("register payments billing checkout", context);
  await commands.get("ttr").handler("list", context);

  assert.match(notifications.at(-1).message, /DOMAIN\s+ALIASES\s+SESSION\s+STATUS/);
  assert.match(notifications.at(-1).message, /payments\s+billing, checkout\s+session-123\s+active/);
  await commands.get("ttr").handler("deactivate billing", context);
  await commands.get("ttr").handler("list", context);
  assert.match(notifications.at(-1).message, /payments\s+billing, checkout\s+session-123\s+inactive/);
  await commands.get("ttr").handler("list --active", context);
  assert.doesNotMatch(notifications.at(-1).message, /payments/);
  await commands.get("ttr").handler("list --json", context);
  assert.equal(JSON.parse(notifications.at(-1).message).length, 1);
});

test("/ttr unregister removes a domain or an entire Manager", async () => {
  const triageControlPlane = await loadExtension();
  const { api, commands, notifications, context } = setupApi();
  triageControlPlane(api);
  await commands.get("ttr").handler("register payments billing", context);
  await commands.get("ttr").handler("unregister billing", context);
  assert.equal(notifications.at(-1).message, "TTR Manager domain unregistered: billing");
  await commands.get("ttr").handler("unregister payments --all", context);
  assert.equal(notifications.at(-1).message, "TTR Manager unregistered: payments");
});

test("/ttr Manager lifecycle commands reject other sessions and accept the Manager or active admin", async () => {
  const triageControlPlane = await loadExtension("admin-session");
  const { api, commands, tools, context } = setupApi("manager-session");
  triageControlPlane(api);
  await commands.get("ttr").handler("register payments billing", context);

  await assert.rejects(() => commands.get("ttr").handler("unregister billing", setupApi("other-session").context), /not authorized to unregister Manager registration/i);
  await assert.rejects(() => commands.get("ttr").handler("deactivate payments", setupApi("other-session").context), /not authorized to deactivate Manager registration/i);
  await commands.get("ttr").handler("unregister billing", context);

  const adminContext = setupApi("admin-session").context;
  await tools.get("ttr_register_admin").execute("tool", { sessionId: "admin-session" }, undefined, undefined, adminContext);
  await commands.get("ttr").handler("deactivate payments", adminContext);
});

test("/ttr ui retrieves a defect by ID", async () => {
  const triageControlPlane = await loadExtension();
  const { api, commands, notifications, context } = setupApi();
  context.ui.select = async () => "Find defect";
  context.ui.input = async () => "missing-defect";
  triageControlPlane(api);

  await commands.get("ttr").handler("ui", context);
  assert.equal(notifications.at(-1).message, "TTR defect not found: missing-defect");
});

test("/ttr UI reconciles an admin-selected defect through the authorized core path", async () => {
  const triageControlPlane = await loadExtension("session-123");
  const { api, commands, tools, context } = setupApi();
  triageControlPlane(api);
  await commands.get("ttr").handler("register payments", context);
  const intake = await tools.get("ttr_intake_for_owner").execute("", {
    reporter: "customer", source: "support", sourceDomain: "storefront", ownerDomain: "payments",
    symptom: "declined", impact: "checkout blocked", environment: "prod", reproduction: "submit card", evidenceReferences: [],
  }, undefined, undefined, context);
  await commands.get("ttr").handler("register --admin", context);
  const choices = ["Admin reconciliation", "Mark assignment orphaned"];
  const inputs = [intake.details.defect.id, "manager session expired", "ticket:123"];
  context.ui.select = async () => choices.shift();
  context.ui.input = async () => inputs.shift();
  context.ui.confirm = async () => true;

  await commands.get("ttr").handler("ui", context);
  const lookup = await tools.get("ttr_admin_lookup").execute("", {}, undefined, undefined, context);
  assert.equal(lookup.details.defects.find(defect => defect.id === intake.details.defect.id).pocAssignment.status, "orphaned");
});

test("ttr_intake_for_owner resolves the registered POC without a target session ID", async () => {
  const triageControlPlane = await loadExtension();
  const { api, commands, tools, context } = setupApi();
  triageControlPlane(api);
  await commands.get("ttr").handler("register payments", context);

  const result = await tools.get("ttr_intake_for_owner").execute("", {
    reporter: "customer", source: "support:123", sourceDomain: "storefront", ownerDomain: "payments",
    symptom: "card declined", impact: "checkout blocked", environment: "prod", reproduction: "submit card", evidenceReferences: [],
  }, undefined, undefined, context);

  assert.equal(result.details.role, "poc");
  assert.equal(result.details.defect.intake.targetPocSessionId, "session-123");
});

test("/ttr --admin flags enroll, list, and revoke only with active admin authority", async () => {
  const triageControlPlane = await loadExtension("session-123");
  const { api, commands, tools, notifications, context } = setupApi();
  triageControlPlane(api);

  await commands.get("ttr").handler("register --admin", context);
  await commands.get("ttr").handler("register --admin --session-id admin-2", context);
  await commands.get("ttr").handler("list --admin --json", context);
  assert.equal(JSON.parse(notifications.at(-1).message).length, 2);
  await assert.rejects(() => commands.get("ttr").handler("unregister admin-2 --admin", setupApi("untrusted").context), /explicitly enrolled active TTR admin/i);
  await commands.get("ttr").handler("unregister admin-2 --admin", context);
  assert.equal(notifications.at(-1).message, "TTR admin unregistered: admin-2");
  await assert.rejects(() => tools.get("ttr_register_admin").execute("tool", { sessionId: "admin-2" }, undefined, undefined, context), /deactivated and cannot be reactivated/i);
});

test("/ttr autoname opt-in updates only unclaimed TTR session names and force can override", async () => {
  const triageControlPlane = await loadExtension();
  const { api, commands, sessionNames, setSessionName, context } = setupApi();
  triageControlPlane(api);

  await commands.get("ttr").handler("register payments", context);
  await commands.get("ttr").handler("autoname on", context);
  assert.deepEqual(sessionNames, ["ttr: payments"]);

  setSessionName("user: incident triage");
  await commands.get("ttr").handler("pocs", context);
  assert.deepEqual(sessionNames, ["ttr: payments"]);

  await commands.get("ttr").handler("autoname refresh --force", context);
  assert.deepEqual(sessionNames, ["ttr: payments", "ttr: payments"]);
});

test("/ttr consolidates POC commands and derives an omitted domain from the repository", async () => {
  const triageControlPlane = await loadExtension();
  const { api, commands, notifications, context } = setupApi();
  triageControlPlane(api);

  assert.deepEqual([...commands.keys()], ["ttr"]);
  const complete = commands.get("ttr").getArgumentCompletions;
  assert.deepEqual(complete("").map(({ value }) => value), ["register", "status", "list", "ui", "unregister", "deactivate", "autoname"]);
  assert.deepEqual(complete("st").map(({ value }) => value), ["status"]);
  assert.deepEqual(complete("register ").map(({ value }) => value), ["--replace", "--session-id", "--admin"]);
  assert.deepEqual(complete("list ").map(({ value }) => value), ["--active", "--json", "--admin"]);

  await commands.get("ttr").handler("register payments", context);
  await commands.get("ttr").handler("status", context);
  await commands.get("ttr").handler("status --json", context);
  await commands.get("ttr").handler("list --active", context);
  await commands.get("ttr").handler("deactivate", context);

  assert.equal(notifications[0].message, "TTR Manager registered: payments → session-123");
  assert.match(notifications[1].message, /MANAGER\s+DOMAIN/);
  const manager = JSON.parse(notifications[2].message);
  assert.equal(typeof manager.managerName, "string");
  delete manager.managerName;
  assert.deepEqual(manager, {
    domain: "payments",
    canonicalDomain: "payments",
    sessionId: "session-123",
    projectBoundary: "/repos/payments/src",
    registeredAt: manager.registeredAt,
    active: true,
  });
  assert.match(notifications[3].message, /payments/);
  assert.equal(notifications[4].message, "TTR Manager deactivated: payments");
});
