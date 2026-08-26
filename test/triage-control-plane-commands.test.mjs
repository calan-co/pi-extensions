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
  return {
    commands,
    tools,
    notifications,
    api: {
      registerCommand(name, spec) { commands.set(name, spec); },
      registerTool(spec) { tools.set(spec.name, spec); },
      setSessionName() {},
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
  const { api, commands, tools, notifications, context } = setupApi();
  triageControlPlane(api);

  assert.ok(tools.has("ttr_reassign_work_item"));
  await commands.get("ttr").handler("register pi-extensions ttr agent-workflows handoff", context);
  await commands.get("ttr").handler("poc handoff", context);

  assert.equal(notifications[0].message, "TTR POC registered: pi-extensions, ttr, agent-workflows, handoff → session-123");
  assert.equal(JSON.parse(notifications[1].message).sessionId, "session-123");
});

test("/ttr consolidates POC commands and derives an omitted domain from the repository", async () => {
  const triageControlPlane = await loadExtension();
  const { api, commands, notifications, context } = setupApi();
  triageControlPlane(api);

  assert.deepEqual([...commands.keys()], ["ttr"]);
  const complete = commands.get("ttr").getArgumentCompletions;
  assert.deepEqual(complete("").map(({ value }) => value), ["register", "poc", "pocs", "deactivate"]);
  assert.deepEqual(complete("po").map(({ value }) => value), ["poc", "pocs"]);
  assert.deepEqual(complete("register ").map(({ value }) => value), ["--replace", "--session-id"]);

  await commands.get("ttr").handler("register payments", context);
  await commands.get("ttr").handler("poc", context);
  await commands.get("ttr").handler("pocs", context);
  await commands.get("ttr").handler("deactivate", context);

  assert.equal(notifications[0].message, "TTR POC registered: payments → session-123");
  assert.deepEqual(JSON.parse(notifications[1].message), {
    domain: "payments",
    sessionId: "session-123",
    projectBoundary: "/repos/payments/src",
    registeredAt: JSON.parse(notifications[1].message).registeredAt,
    active: true,
  });
  assert.equal(JSON.parse(notifications[2].message).length, 1);
  assert.equal(notifications[3].message, "TTR POC deactivated: payments");
});
