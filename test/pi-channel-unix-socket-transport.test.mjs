import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixChannelPublisher } from "../extensions/pi-channel/unix-socket-transport.ts";
import { attachPiMembershipPublisher } from "../extensions/pi-channel/mirror-adapter.ts";
import { publishPiMembership } from "../extensions/pi-channel/membership-source.ts";

async function listener(socketPath, capability, received) {
  const clients = new Set();
  const server = createServer(socket => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    let pending = "";
    socket.on("data", chunk => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        const message = JSON.parse(line);
        received.push(message);
        if (message.type === "hello") {
          if (message.cap !== capability) return socket.end('{"v":1,"type":"error","code":"unauthorized"}\n');
        } else if (message.type === "membership") {
          socket.write(`{"v":1,"type":"ack","seq":${message.seq}}\n`);
        }
      }
    });
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
  server.clients = clients;
  return server;
}

function publisher(socketPath) {
  return new UnixChannelPublisher({ piSessionId: "pi-session-123", piSessionFile: null, socketPath });
}

test("UnixChannelPublisher authenticates primitive Pi membership snapshots", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-channel-test-"));
  await chmod(root, 0o700);
  const socketPath = join(root, "socket");
  const capability = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await writeFile(join(root, "capability"), `${capability}\n`, { mode: 0o600 });
  const received = [];
  const server = await listener(socketPath, capability, received);
  t.after(() => server.close());

  const value = publisher(socketPath);
  t.after(() => value.close());
  await value.snapshot([" TTR "]);
  assert.deepEqual(value.diagnostic(), {
    socketPath,
    connection: "connected",
    lastPublish: {
      at: value.diagnostic().lastPublish.at,
      seq: 1,
      channels: ["ttr"],
    },
    lastError: null,
  });
  assert.match(value.diagnostic().lastPublish.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(Object.hasOwn(value.diagnostic(), "capability"), false);
  await value.delta("join", "workflows");
  value.close();
  await value.delta("leave", "ttr");

  assert.deepEqual(received.map(message => message.type), ["hello", "membership", "membership", "hello", "membership"]);
  for (const [index, seq, channels] of [[1, 1, ["ttr"]], [2, 2, ["ttr", "workflows"]], [4, 3, ["workflows"]]]) {
    assert.deepEqual(received[index], {
      v: 1,
      type: "membership",
      piSessionId: "pi-session-123",
      piSessionFile: null,
      epoch: received[1].epoch,
      seq,
      channels,
    });
  }
  assert.match(received[1].epoch, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(process.argv.includes(capability), false);
});

test("UnixChannelPublisher sends the canonical Pi session-file snapshot field", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-channel-test-"));
  await chmod(root, 0o700);
  const socketPath = join(root, "socket");
  const capability = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const sessionFile = join(root, "pi-session-123.jsonl");
  await writeFile(join(root, "capability"), `${capability}\n`, { mode: 0o600 });
  await writeFile(sessionFile, "{}");
  const received = [];
  const server = await listener(socketPath, capability, received);
  t.after(() => server.close());
  const value = publisher(socketPath);
  t.after(() => value.close());
  await value.snapshot(["ttr"], sessionFile);
  assert.equal(received[1].piSessionFile, sessionFile);
});

test("lifecycle hook emits no Oppi association through the authenticated transport", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-channel-test-"));
  await chmod(root, 0o700);
  const socketPath = join(root, "socket");
  const capability = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await writeFile(join(root, "capability"), `${capability}\n`, { mode: 0o600 });
  const received = [];
  const server = await listener(socketPath, capability, received);
  t.after(() => server.close());

  const mirror = attachPiMembershipPublisher({ piSessionId: "pi-mirror-session-123", piSessionFile: null }, new UnixChannelPublisher({
    piSessionId: "pi-mirror-session-123",
    piSessionFile: null,
    socketPath,
  }));
  t.after(() => mirror.close());
  publishPiMembership({ piSessionId: "pi-mirror-session-123", piSessionFile: null, channels: ["ttr"] });
  await mirror.flush();

  assert.deepEqual(received.map(message => message.type), ["hello", "membership"]);
  assert.equal(received[1].piSessionId, "pi-mirror-session-123");
  assert.equal(Object.hasOwn(received[1], "oppiSessionId"), false);
  assert.deepEqual(received[1].channels, ["ttr"]);
});

test("the production /channel entrypoint publishes a membership snapshot through the real socket", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-channel-test-"));
  await chmod(root, 0o700);
  const socketPath = join(root, "production.socket");
  const capability = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await writeFile(join(root, "capability"), `${capability}\n`, { mode: 0o600 });
  const received = [];
  const server = await listener(socketPath, capability, received);
  t.after(() => server.close());
  const script = `
    import piChannel from './extensions/pi-channel/index.ts';
    const commands = new Map();
    piChannel({ appendEntry() {}, registerCommand(name, spec) { commands.set(name, spec); } });
    await commands.get('channel').handler('join ttr', {
      ui: { notify() {} },
      sessionManager: { getSessionId: () => 'production-session-123', getBranch: () => [] },
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    process.exit(0);
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PI_CHANNEL_SOCKET_PATH: socketPath },
  });
  const stderr = [];
  child.stderr.on("data", value => stderr.push(value));
  await new Promise((resolve, reject) => child.once("exit", code => code === 0 ? resolve() : reject(new Error(Buffer.concat(stderr).toString()))));
  assert.deepEqual(received.map(message => message.type), ["hello", "membership"]);
  assert.equal(received[1].piSessionId, "production-session-123");
  assert.deepEqual(received[1].channels, ["ttr"]);
});

test("a restarted Pi process reloads its persisted branch and republishes the canonical session-file association", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-channel-restart-"));
  await chmod(root, 0o700);
  const socketPath = join(root, "socket");
  const capability = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const sessionFile = join(root, "pi-session-123.jsonl");
  const branchFile = join(root, "branch.json");
  await writeFile(join(root, "capability"), `${capability}\n`, { mode: 0o600 });
  await writeFile(sessionFile, "{}");
  const firstProcess = `
    import { readFileSync, writeFileSync } from 'node:fs';
    import piChannel from './extensions/pi-channel/index.ts';
    const commands = new Map();
    const branchFile = process.env.TEST_BRANCH_FILE;
    const readBranch = () => { try { return JSON.parse(readFileSync(branchFile, 'utf8')); } catch { return []; } };
    piChannel({
      appendEntry(customType, data) { writeFileSync(branchFile, JSON.stringify([...readBranch(), { type: 'custom', customType, data }])); },
      registerCommand(name, spec) { commands.set(name, spec); },
    });
    await commands.get('channel').handler('join ttr', {
      ui: { notify() {} },
      sessionManager: { getSessionId: () => 'pi-session-123', getSessionFile: () => process.env.TEST_SESSION_FILE, getBranch: readBranch },
    });
    process.exit(0);
  `;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", firstProcess], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, TEST_BRANCH_FILE: branchFile, TEST_SESSION_FILE: sessionFile },
    });
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`initial Pi process exited ${code}`)));
  });
  const received = [];
  const server = await listener(socketPath, capability, received);
  t.after(() => server.close());
  const restartedProcess = `
    import { readFileSync } from 'node:fs';
    import piChannel from './extensions/pi-channel/index.ts';
    const handlers = new Map();
    piChannel({ appendEntry() {}, registerCommand() {}, on(name, handler) { handlers.set(name, handler); } });
    await handlers.get('session_start')({}, {
      sessionManager: {
        getSessionId: () => 'pi-session-123',
        getSessionFile: () => process.env.TEST_SESSION_FILE,
        getBranch: () => JSON.parse(readFileSync(process.env.TEST_BRANCH_FILE, 'utf8')),
      },
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    process.exit(0);
  `;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", restartedProcess], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, PI_CHANNEL_SOCKET_PATH: socketPath, TEST_BRANCH_FILE: branchFile, TEST_SESSION_FILE: sessionFile },
    });
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`restarted Pi process exited ${code}`)));
  });
  assert.deepEqual(received.map(message => message.type), ["hello", "membership"]);
  assert.deepEqual(received[1].channels, ["ttr"]);
  assert.equal(received[1].piSessionFile, await realpath(sessionFile));
});

test("UnixChannelPublisher reconnects and replays a snapshot after the relay socket closes", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-channel-test-"));
  await chmod(root, 0o700);
  const socketPath = join(root, "socket");
  const capability = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await writeFile(join(root, "capability"), `${capability}\n`, { mode: 0o600 });
  const firstMessages = [];
  const first = await listener(socketPath, capability, firstMessages);
  const value = publisher(socketPath);
  t.after(() => value.close());
  await value.snapshot(["ttr"]);
  for (const socket of first.clients) socket.destroy();
  await new Promise(resolve => first.close(resolve));
  const resumed = [];
  const second = await listener(socketPath, capability, resumed);
  t.after(() => second.close());
  await new Promise(resolve => {
    const poll = () => resumed.some(message => message.type === "membership") ? resolve() : setTimeout(poll, 10);
    poll();
  });
  assert.deepEqual(resumed.map(message => message.type), ["hello", "membership"]);
  assert.equal(Object.hasOwn(resumed[1], "oppiSessionId"), false);
  assert.deepEqual(resumed[1].channels, ["ttr"]);
});

test("UnixChannelPublisher uses PI_CHANNEL_SOCKET_PATH and retries an initial relay absence", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-channel-test-"));
  await chmod(root, 0o700);
  const socketPath = join(root, "non-default.socket");
  const capability = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await writeFile(join(root, "capability"), `${capability}\n`, { mode: 0o600 });
  const previous = process.env.PI_CHANNEL_SOCKET_PATH;
  process.env.PI_CHANNEL_SOCKET_PATH = socketPath;
  const value = new UnixChannelPublisher({ piSessionId: "pi-session-123", piSessionFile: null });
  t.after(() => {
    value.close();
    if (previous === undefined) delete process.env.PI_CHANNEL_SOCKET_PATH;
    else process.env.PI_CHANNEL_SOCKET_PATH = previous;
  });
  assert.equal(value.socketPath, socketPath);
  await assert.rejects(value.snapshot(["ttr"]), /ENOENT|ECONNREFUSED/);

  const received = [];
  const server = await listener(socketPath, capability, received);
  t.after(() => server.close());
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("publisher did not retry initial connection")), 2_000);
    const poll = () => {
      if (received.some(message => message.type === "membership")) {
        clearTimeout(deadline);
        resolve();
      } else setTimeout(poll, 10);
    };
    poll();
  });
  assert.deepEqual(received.map(message => message.type), ["hello", "membership"]);
  assert.deepEqual(received[1].channels, ["ttr"]);
});

test("UnixChannelPublisher rejects a relative shared socket configuration", () => {
  const previous = process.env.PI_CHANNEL_SOCKET_PATH;
  process.env.PI_CHANNEL_SOCKET_PATH = "relative.socket";
  try {
    assert.throws(() => new UnixChannelPublisher({ piSessionId: "pi-session-123", piSessionFile: null }), /absolute/);
  } finally {
    if (previous === undefined) delete process.env.PI_CHANNEL_SOCKET_PATH;
    else process.env.PI_CHANNEL_SOCKET_PATH = previous;
  }
});

test("UnixChannelPublisher rejects unsafe capability permissions and never connects", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-channel-test-"));
  await chmod(root, 0o700);
  const socketPath = join(root, "socket");
  await writeFile(join(root, "capability"), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n", { mode: 0o644 });
  const value = publisher(socketPath);
  await assert.rejects(value.snapshot(["ttr"]), /0600/);
  assert.equal(value.diagnostic().connection, "disconnected");
  assert.equal(value.diagnostic().lastPublish, null);
  assert.match(value.diagnostic().lastError, /0600/);
});
