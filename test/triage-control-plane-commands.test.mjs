import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadExtension() {
  process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "ttr-command-state-"));
  return (await import(`../extensions/triage-control-plane/index.ts?test=${Date.now()}-${Math.random()}`)).default;
}

function setupApi() {
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
      sessionManager: { getSessionId: () => "session-123" },
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
  assert.ok(tools.has("ttr_admin_lookup"));
  assert.ok(tools.has("ttr_mark_poc_assignment_orphaned"));
  assert.ok(tools.has("ttr_admin_rebind_work_item"));
  assert.ok(tools.has("ttr_supersede_work_item"));
  await commands.get("ttr").handler("register pi-extensions ttr agent-workflows handoff", context);
  await commands.get("ttr").handler("manager handoff", context);

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
  assert.deepEqual(complete("").map(({ value }) => value), ["register", "status", "list", "unregister", "deactivate", "admins", "autoname"]);
  assert.deepEqual(complete("st").map(({ value }) => value), ["status"]);
  assert.deepEqual(complete("register ").map(({ value }) => value), ["--replace", "--session-id"]);
  assert.deepEqual(complete("list ").map(({ value }) => value), ["--active"]);

  await commands.get("ttr").handler("register payments", context);
  await commands.get("ttr").handler("status", context);
  await commands.get("ttr").handler("list --active", context);
  await commands.get("ttr").handler("deactivate", context);

  assert.equal(notifications[0].message, "TTR Manager registered: payments → session-123");
  const manager = JSON.parse(notifications[1].message);
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
  assert.match(notifications[2].message, /payments/);
  assert.equal(notifications[3].message, "TTR Manager deactivated: payments");
});
