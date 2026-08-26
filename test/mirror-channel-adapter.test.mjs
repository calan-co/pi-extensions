import test from "node:test";
import assert from "node:assert/strict";
import piChannel from "../extensions/pi-channel/index.ts";
import { attachPiMembershipPublisher } from "../extensions/pi-channel/mirror-adapter.ts";

test("lifecycle publisher emits branch membership after /channel changes without an Oppi ID", async t => {
  const snapshots = [];
  const publisher = attachPiMembershipPublisher({ piSessionId: "pi-runtime-123", piSessionFile: null }, {
    async snapshot(channels) { snapshots.push([...channels]); },
  });
  t.after(() => publisher.close());

  const commands = new Map();
  const journal = [];
  piChannel({
    appendEntry(customType, data) { journal.push({ customType, data }); },
    registerCommand(name, spec) { commands.set(name, spec); },
  });
  const context = {
    ui: { notify() {} },
    sessionManager: {
      getSessionId: () => "pi-runtime-123",
      getBranch: () => [],
    },
  };

  await commands.get("channel").handler("join ttr", context);
  await publisher.flush();

  assert.deepEqual(journal, [{
    customType: "pi-channel",
    data: { version: 1, op: "join", channel: "ttr", source: "pi-channel" },
  }]);
  assert.deepEqual(snapshots, [["ttr"]]);
});
