import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import piChannel, { zellijLocationFromEnvironment } from "../extensions/pi-channel/index.ts";
import { channelRecord, channelTranscriptSummary, parseChannelCommand } from "../extensions/pi-channel/channel.ts";
import {
  channelEvent,
  InProcessChannelTransport,
  publishChannelEvent,
} from "../extensions/pi-channel/transport.ts";

const root = new URL("..", import.meta.url);

test("Zellij attention location requires inherited session and numeric pane values", () => {
  const previousSession = process.env.ZELLIJ_SESSION_NAME;
  const previousPane = process.env.ZELLIJ_PANE_ID;
  try {
    process.env.ZELLIJ_SESSION_NAME = "project";
    process.env.ZELLIJ_PANE_ID = "42";
    assert.deepEqual(zellijLocationFromEnvironment(), { sessionName: "project", paneId: 42 });
    process.env.ZELLIJ_PANE_ID = "not-a-pane";
    assert.equal(zellijLocationFromEnvironment(), null);
  } finally {
    if (previousSession === undefined) delete process.env.ZELLIJ_SESSION_NAME;
    else process.env.ZELLIJ_SESSION_NAME = previousSession;
    if (previousPane === undefined) delete process.env.ZELLIJ_PANE_ID;
    else process.env.ZELLIJ_PANE_ID = previousPane;
  }
});

test("pi-channel records normalize names and preserve operation", () => {
  assert.deepEqual(channelRecord("join", " TTR ", "ttr"), { version: 1, op: "join", channel: "ttr", source: "ttr" });
  assert.throws(() => channelRecord("leave", " "), /required/);
});

test("channel command accepts join leave list and diagnostics only", () => {
  assert.deepEqual(parseChannelCommand("join ttr"), { action: "join", channel: "ttr" });
  assert.deepEqual(parseChannelCommand("list"), { action: "list" });
  assert.deepEqual(parseChannelCommand("diagnostics"), { action: "diagnostics" });
  assert.throws(() => parseChannelCommand("join"), /Usage/);
});

test("pi-channel registers a bounded durable transcript projection", () => {
  const renderers = new Map();
  piChannel({ appendEntry() {}, registerCommand() {}, registerEntryRenderer(type, renderer) { renderers.set(type, renderer); } });
  assert.ok(renderers.has("pi-channel"));

  const summary = channelTranscriptSummary({
    version: 1,
    op: "join",
    channel: "ops-".repeat(20),
    source: "pi-channel",
    sessionFile: "/private/session.jsonl",
    token: "do-not-display",
  });
  assert.match(summary, /^Channel joined: /);
  assert.ok(summary.length <= 64);
  assert.doesNotMatch(summary, /private|do-not-display|sessionFile|token/);
  assert.equal(channelTranscriptSummary({ path: "/private/session.jsonl", token: "do-not-display" }), "Channel membership activity");
});

test("pi-channel is packaged, appends durable membership records, and lists the active branch", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.ok(packageJson.pi.extensions.includes("extensions/pi-channel/index.ts"));
  await access(join(root.pathname, "extensions/pi-channel/index.ts"));

  const commands = new Map();
  const appended = [];
  const notifications = [];
  piChannel({
    appendEntry(customType, data) { appended.push({ customType, data }); },
    registerCommand(name, spec) { commands.set(name, spec); },
  });

  const channel = commands.get("channel");
  assert.ok(channel);
  const context = {
    ui: { notify(message, level) { notifications.push({ message, level }); } },
    sessionManager: {
      getSessionId: () => "pi-runtime-123",
      getBranch: () => [
        { type: "custom", customType: "pi-channel", data: { version: 1, op: "join", channel: "ops" } },
      ],
      getEntries: () => [
        { type: "custom", customType: "pi-channel", data: { version: 1, op: "join", channel: "ops" } },
        { type: "custom", customType: "pi-channel", data: { version: 1, op: "join", channel: "stale-branch" } },
      ],
    },
  };

  await channel.handler("join TTR", context);
  await channel.handler("leave ttr", context);
  await channel.handler("list", context);

  assert.deepEqual(appended, [
    { customType: "pi-channel", data: { version: 1, op: "join", channel: "ttr", source: "pi-channel" } },
    { customType: "pi-channel", data: { version: 1, op: "leave", channel: "ttr", source: "pi-channel" } },
  ]);
  assert.deepEqual(notifications, [
    { message: "Joined channel ttr", level: "info" },
    { message: "Left channel ttr", level: "info" },
    { message: "ops", level: "info" },
  ]);
});

test("channel diagnostics reports publisher state without exposing capability data", async () => {
  const commands = new Map();
  const notifications = [];
  piChannel({ appendEntry() {}, registerCommand(name, spec) { commands.set(name, spec); } });

  await commands.get("channel").handler("diagnostics", {
    ui: { notify(message, level) { notifications.push({ message, level }); } },
    sessionManager: { getSessionId: () => "pi-diagnostic-123", getBranch: () => [] },
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "info");
  const diagnostic = JSON.parse(notifications[0].message);
  assert.equal(diagnostic.connection, "disconnected");
  assert.match(diagnostic.socketPath, /^\//);
  assert.equal(Object.hasOwn(diagnostic, "capability"), false);
  assert.equal(Object.hasOwn(diagnostic, "cap"), false);
});

test("injected publisher receives a normalized channel event", async () => {
  const published = [];
  const publisher = { publish: async event => published.push(event) };

  await publishChannelEvent(publisher, {
    version: 1,
    kind: "channel.event",
    eventId: "event-1",
    channel: " TTR ",
    subject: " session-1 ",
    payload: { state: "ready" },
  });

  assert.deepEqual(published, [{
    version: 1,
    kind: "channel.event",
    eventId: "event-1",
    channel: "ttr",
    subject: "session-1",
    payload: { state: "ready" },
  }]);
  assert.deepEqual(channelEvent({
    version: 1,
    kind: "channel.event",
    eventId: "event-2",
    channel: "ttr",
    subject: " ",
    payload: {},
  }), {
    version: 1,
    kind: "channel.event",
    eventId: "event-2",
    channel: "ttr",
    payload: {},
  });
  assert.throws(() => channelEvent({
    version: 1,
    kind: "channel.event",
    eventId: " ",
    channel: "ttr",
    payload: {},
  }), /event ID/);
});

test("in-process adapter delivers only subscribed channels and stops on unsubscribe", async () => {
  const transport = new InProcessChannelTransport();
  const received = [];
  const unsubscribe = transport.subscribe(["ttr"], event => received.push(event.eventId));
  await transport.publish({ version: 1, kind: "channel.event", eventId: "ignored", channel: "other", payload: {} });
  await transport.publish({ version: 1, kind: "channel.event", eventId: "delivered", channel: "ttr", payload: {} });
  unsubscribe();
  await transport.publish({ version: 1, kind: "channel.event", eventId: "after", channel: "ttr", payload: {} });
  assert.deepEqual(received, ["delivered"]);
});
