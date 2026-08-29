import { lstat, readFile } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";
import { dirname, isAbsolute, join } from "node:path";

const MAX_LINE_BYTES = 64 * 1024;
const SOURCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CHANNEL = /^[a-z0-9][a-z0-9._/-]{0,63}$/;

type Outbound =
  | { v: 1; type: "hello"; cap: string; role: "publisher"; source: string }
  | { v: 1; type: "membership"; piSessionId: string; piSessionFile: string | null; epoch: string; seq: number; channels: string[] };
const RELAY_ERROR_CODES = [
  "unauthorized",
  "invalid",
  "malformed-json",
  "missing-channels",
  "invalid-channel",
  "invalid-epoch",
  "invalid-sequence",
  "stale-sequence",
  "stale-epoch",
  "source-mismatch",
  "invalid-frame",
  "invalid-protocol",
  "invalid-schema",
  "missing-pi-session-file",
  "null-pi-session-file",
  "invalid-pi-session-file",
  "session-file-id-mismatch",
] as const;
type RelayErrorCode = typeof RELAY_ERROR_CODES[number];
type Inbound = { v: 1; type: "ack"; seq: number } | { v: 1; type: "error"; code: RelayErrorCode } | { v: 1; type: "snapshot.request" };

export interface UnixChannelPublisherOptions {
  /** Stable public Pi session identifier supplied by the Pi runtime. */
  piSessionId: string;
  /** Canonical Pi session-file path, or null when this runtime cannot resolve one. */
  piSessionFile: string | null;
  /** Non-secret absolute socket path. Defaults to PI_CHANNEL_SOCKET_PATH or the secure runtime path. */
  socketPath?: string;
  capabilityPath?: string;
}

/** Safe-to-display local publisher state. Capability data is intentionally absent. */
export interface UnixChannelPublisherDiagnostic {
  socketPath: string;
  connection: "connected" | "disconnected";
  lastPublish: { at: string; seq: number; channels: string[] } | null;
  lastError: string | null;
}

export function normalizeMembershipChannels(channels: readonly string[]): string[] {
  const values = [...new Set(channels.map(channel => channel.trim().toLowerCase()).filter(Boolean))].sort();
  if (values.some(channel => !CHANNEL.test(channel))) throw new Error("invalid channel name for local adapter");
  return values;
}

/** Resolves a non-secret socket location. The relay is the only process that creates it. */
export function defaultUnixChannelSocketPath(): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime && isAbsolute(runtime)) {
    try {
      const info = lstatSync(runtime);
      if (info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0) return join(runtime, "pi-channel-v1", "socket");
    } catch { /* relay and publisher both fall back below */ }
  }
  return join("/tmp", `pi-channel-${process.getuid?.() ?? "unknown"}`, "socket");
}

/** Shared non-secret relay/publisher override. It must name an absolute Unix socket. */
export function configuredUnixChannelSocketPath(): string {
  const configured = process.env.PI_CHANNEL_SOCKET_PATH;
  if (configured === undefined) return defaultUnixChannelSocketPath();
  if (!isAbsolute(configured) || configured.includes("\0")) {
    throw new Error("local adapter socket path must be absolute");
  }
  return configured;
}

async function secureDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  const uid = process.getuid?.();
  if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid)) throw new Error("local adapter runtime directory is not owned by this user");
  if ((info.mode & 0o077) !== 0) throw new Error("local adapter runtime directory must be 0700");
}

async function readCapability(path: string): Promise<string> {
  await secureDirectory(dirname(path));
  const info = await lstat(path);
  const uid = process.getuid?.();
  if (!info.isFile() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid)) throw new Error("local adapter capability is not an owned regular file");
  if ((info.mode & 0o077) !== 0) throw new Error("local adapter capability must be 0600");
  const capability = (await readFile(path, "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) throw new Error("local adapter capability is invalid");
  return capability;
}

function encode(message: Outbound): string {
  const line = JSON.stringify(message);
  if (Buffer.byteLength(line) >= MAX_LINE_BYTES) throw new Error("local adapter message is too large");
  return `${line}\n`;
}

function relayErrorCode(value: unknown): value is RelayErrorCode {
  return typeof value === "string" && (RELAY_ERROR_CODES as readonly string[]).includes(value);
}

function parseInbound(line: string): Inbound {
  let message: unknown;
  try { message = JSON.parse(line); } catch { throw new Error("local adapter returned invalid JSON"); }
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("local adapter returned invalid message");
  const value = message as Record<string, unknown>;
  if (value.v !== 1 || typeof value.type !== "string") throw new Error("local adapter returned invalid message");
  if (value.type === "ack" && typeof value.seq === "number" && Number.isSafeInteger(value.seq) && Object.keys(value).length === 3) return value as Inbound;
  if (value.type === "error" && relayErrorCode(value.code) && Object.keys(value).length === 3) return value as Inbound;
  if (value.type === "snapshot.request" && Object.keys(value).length === 2) return value as Inbound;
  throw new Error("local adapter returned invalid message");
}

/** Authenticated NDJSON publisher. A new socket always starts with a complete snapshot. */
export class UnixChannelPublisher {
  readonly piSessionId: string;
  readonly socketPath: string;
  readonly capabilityPath: string;
  private piSessionFile: string | null;
  private socket?: Socket;
  private buffer = "";
  private readonly epoch = randomBytes(16).toString("base64url");
  private sequence = 0;
  private channels: string[] = [];
  private started = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectDelayMs = 50;
  private lastPublish: UnixChannelPublisherDiagnostic["lastPublish"] = null;
  private lastError: string | null = null;
  private pending?: { seq: number; resolve: () => void; reject: (error: Error) => void; onAck?: () => void };

  constructor(options: UnixChannelPublisherOptions) {
    if (!SOURCE.test(options.piSessionId)) throw new Error("local adapter Pi session identity is invalid");
    this.piSessionId = options.piSessionId;
    if (options.piSessionFile !== null && (!isAbsolute(options.piSessionFile) || options.piSessionFile.includes("\0"))) throw new Error("local adapter Pi session file must be absolute");
    this.piSessionFile = options.piSessionFile;
    this.socketPath = options.socketPath ?? configuredUnixChannelSocketPath();
    if (!isAbsolute(this.socketPath) || this.socketPath.includes("\0")) throw new Error("local adapter socket path must be absolute");
    this.capabilityPath = options.capabilityPath ?? join(dirname(this.socketPath), "capability");
  }

  async snapshot(channels: readonly string[], piSessionFile = this.piSessionFile): Promise<void> {
    if (piSessionFile !== null && (!isAbsolute(piSessionFile) || piSessionFile.includes("\0"))) throw new Error("local adapter Pi session file must be absolute");
    this.piSessionFile = piSessionFile;
    this.channels = normalizeMembershipChannels(channels);
    this.started = true;
    try {
      const reconnected = await this.ensureConnected();
      if (!reconnected) await this.sendMembership();
    } catch (error) {
      this.rememberError(error);
      this.dropSocket();
      // A `/channel` mutation must remain durable even before its relay starts.
      // Retain the snapshot and retry with capped exponential backoff.
      this.scheduleReconnect();
      throw error;
    }
  }

  async delta(op: "join" | "leave", channel: string): Promise<void> {
    const normalized = normalizeMembershipChannels([channel])[0];
    const next = op === "join" ? [...this.channels, normalized] : this.channels.filter(current => current !== normalized);
    await this.snapshot(next);
  }

  close(): void {
    this.started = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.dropSocket();
  }

  /** Returns connection and delivery state without exposing the local capability. */
  diagnostic(): UnixChannelPublisherDiagnostic {
    return {
      socketPath: this.socketPath,
      connection: this.socket && !this.socket.destroyed ? "connected" : "disconnected",
      lastPublish: this.lastPublish && { ...this.lastPublish, channels: [...this.lastPublish.channels] },
      lastError: this.lastError,
    };
  }

  private rememberError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    // Protocol errors never contain capability data. Bound the diagnostic so a
    // hostile local socket cannot turn it into an unbounded UI payload.
    this.lastError = message.slice(0, 256);
  }

  private dropSocket(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 1_000);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      try {
        await this.ensureConnected();
        this.reconnectDelayMs = 50;
      } catch (error) {
        this.rememberError(error);
        this.scheduleReconnect();
      }
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async ensureConnected(): Promise<boolean> {
    if (this.socket && !this.socket.destroyed) return false;
    const capability = await readCapability(this.capabilityPath);
    const socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = connect(this.socketPath);
      candidate.once("connect", () => resolve(candidate));
      candidate.once("error", reject);
    });
    this.socket = socket;
    this.buffer = "";
    socket.on("data", chunk => this.receive(chunk.toString("utf8")));
    socket.on("close", () => {
      if (this.socket === socket) this.socket = undefined;
      if (this.started) this.rememberError(new Error("local adapter socket closed"));
      this.pending?.reject(new Error("local adapter socket closed"));
      this.pending = undefined;
      this.scheduleReconnect();
    });
    socket.on("error", error => {
      this.rememberError(error);
      this.pending?.reject(error);
      this.pending = undefined;
    });
    await this.send({ v: 1, type: "hello", cap: capability, role: "publisher", source: this.piSessionId }, false);
    // A new socket/restart has no cache; replay the complete Pi membership snapshot.
    await this.sendMembership();
    return true;
  }

  private async sendMembership(): Promise<void> {
    const seq = ++this.sequence;
    const channels = [...this.channels];
    await this.send({
      v: 1,
      type: "membership",
      piSessionId: this.piSessionId,
      piSessionFile: this.piSessionFile,
      epoch: this.epoch,
      seq,
      channels,
    }, true, () => {
      this.lastPublish = { at: new Date().toISOString(), seq, channels };
      this.lastError = null;
    });
  }

  private send(message: Outbound, awaitAck = true, onAck?: () => void): Promise<void> {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error("local adapter socket is unavailable"));
    if (!awaitAck) { this.socket.write(encode(message)); return Promise.resolve(); }
    const seq = "seq" in message ? message.seq : undefined;
    if (seq === undefined || this.pending) return Promise.reject(new Error("local adapter protocol state is invalid"));
    return new Promise((resolve, reject) => {
      this.pending = { seq, resolve, reject, onAck };
      this.socket!.write(encode(message), error => {
        if (error) { this.pending = undefined; reject(error); }
      });
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES) return this.close();
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop()!;
    for (const line of lines) {
      if (!line) { this.close(); return; }
      try {
        const message = parseInbound(line);
        if (message.type === "error") throw new Error(`local adapter rejected message: ${message.code}`);
        if (message.type === "snapshot.request") {
          void this.sendMembership().catch(() => this.dropSocket());
          continue;
        }
        if (!this.pending || message.seq !== this.pending.seq) throw new Error("local adapter returned unexpected acknowledgement");
        const pending = this.pending; this.pending = undefined; pending.onAck?.(); pending.resolve();
      } catch (error) {
        this.rememberError(error);
        this.pending?.reject(error instanceof Error ? error : new Error(String(error)));
        this.pending = undefined;
        this.close();
      }
    }
  }
}
