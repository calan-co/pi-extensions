import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piChannel from "../extensions/pi-channel/index.ts";
import { subscribePiMembership } from "../extensions/pi-channel/membership-source.ts";

test("channel mutations publish branch-derived primitive membership snapshots", async t => {
  const commands = new Map();
  const snapshots = [];
  const unsubscribe = subscribePiMembership(snapshot => snapshots.push(snapshot));
  t.after(unsubscribe);
  piChannel({ appendEntry() {}, registerCommand(name, spec) { commands.set(name, spec); } });
  const context = {
    ui: { notify() {} },
    sessionManager: {
      getSessionId: () => "pi-runtime-123",
      getBranch: () => [{ type: "custom", customType: "pi-channel", data: { version: 1, op: "join", channel: "ops" } }],
    },
  };
  await commands.get("channel").handler("join ttr", context);
  await commands.get("channel").handler("leave ops", context);
  assert.deepEqual(snapshots, [
    { piSessionId: "pi-runtime-123", piSessionFile: null, channels: ["ops", "ttr"] },
    { piSessionId: "pi-runtime-123", piSessionFile: null, channels: [] },
  ]);
});

test("session file path supplies the Pi association source when no session ID is available", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-channel-session-id-"));
  const sessionFile = join(root, "pi-session-123.jsonl");
  await writeFile(sessionFile, "{}");
  const commands = new Map();
  const snapshots = [];
  const unsubscribe = subscribePiMembership(snapshot => snapshots.push(snapshot));
  t.after(unsubscribe);
  piChannel({ appendEntry() {}, registerCommand(name, spec) { commands.set(name, spec); } });

  await commands.get("channel").handler("join ttr", {
    ui: { notify() {} },
    sessionManager: {
      getSessionId: () => " ",
      getSessionFile: () => sessionFile,
      getBranch: () => [],
    },
  });

  assert.deepEqual(snapshots, [{
    piSessionId: "pi-session-123",
    piSessionFile: await realpath(sessionFile),
    channels: ["ttr"],
  }]);
});

test("membership snapshots publish the UAT Pi ID and canonical session-file path", async t => {
  const piSessionId = "01a03be1-0fa0-7c4d-82ba-a503c376cb49";
  const root = await mkdtemp(join(tmpdir(), "pi-channel-session-file-"));
  const actual = join(root, `${piSessionId}.jsonl`);
  const alias = join(root, "session-alias.jsonl");
  await writeFile(actual, "{}");
  await symlink(actual, alias);
  const snapshots = [];
  const unsubscribe = subscribePiMembership(snapshot => snapshots.push(snapshot));
  t.after(unsubscribe);
  const commands = new Map();
  piChannel({ appendEntry() {}, registerCommand(name, spec) { commands.set(name, spec); } });
  await commands.get("channel").handler("join ttr", {
    ui: { notify() {} },
    sessionManager: {
      getSessionId: () => piSessionId,
      getSessionFile: () => alias,
      getBranch: () => [],
    },
  });
  assert.deepEqual(snapshots, [{ piSessionId, piSessionFile: await realpath(actual), channels: ["ttr"] }]);
});

test("session_start publishes the active branch through the primitive Pi seam", async t => {
  const handlers = new Map();
  const snapshots = [];
  const unsubscribe = subscribePiMembership(snapshot => snapshots.push(snapshot));
  t.after(unsubscribe);
  piChannel({
    appendEntry() {},
    registerCommand() {},
    on(name, handler) { handlers.set(name, handler); },
  });
  const context = {
    sessionManager: {
      getSessionId: () => "pi-runtime-123",
      getBranch: () => [
        { type: "custom", customType: "pi-channel", data: { version: 1, op: "join", channel: "ops" } },
        { type: "custom", customType: "pi-channel", data: { version: 1, op: "join", channel: "ttr" } },
        { type: "custom", customType: "pi-channel", data: { version: 1, op: "leave", channel: "ops" } },
      ],
    },
  };
  await handlers.get("session_start")({}, context);
  assert.deepEqual(snapshots, [{ piSessionId: "pi-runtime-123", piSessionFile: null, channels: ["ttr"] }]);
});

test("channel journal remains valid when no Mirror adapter or relay mapping exists", async () => {
  const entrypoint = await readFile(new URL("../extensions/pi-channel/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(entrypoint, /PI_OPPI_MIRROR_SESSION_ID|oppiSessionId/);
  const commands = new Map();
  const journal = [];
  const notifications = [];
  const previousMirror = process.env.PI_OPPI_MIRROR_SESSION_ID;
  process.env.PI_OPPI_MIRROR_SESSION_ID = "must-not-be-read";
  try {
    piChannel({
      appendEntry(customType, data) { journal.push({ customType, data }); },
      registerCommand(name, spec) { commands.set(name, spec); },
    });
    await commands.get("channel").handler("join ttr", {
      ui: { notify(message, level) { notifications.push({ message, level }); } },
      sessionManager: { getSessionId: () => "pi-runtime-123", getBranch: () => [] },
    });
  } finally {
    if (previousMirror === undefined) delete process.env.PI_OPPI_MIRROR_SESSION_ID;
    else process.env.PI_OPPI_MIRROR_SESSION_ID = previousMirror;
  }
  assert.deepEqual(journal, [{
    customType: "pi-channel",
    data: { version: 1, op: "join", channel: "ttr", source: "pi-channel" },
  }]);
  assert.deepEqual(notifications, [{ message: "Joined channel ttr", level: "info" }]);
});
