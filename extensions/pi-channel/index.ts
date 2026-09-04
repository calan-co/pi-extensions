import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { channelRecord, channelTranscriptSummary, parseChannelCommand, type PiChannelRecord } from "./channel.ts";
import { attachPiMembershipPublisher, type MembershipPublisherHandle } from "./mirror-adapter.ts";
import { publishPiMembership } from "./membership-source.ts";
import { canonicalPiSessionFile, piSessionIdentity } from "./session-identity.ts";
import { configuredUnixChannelSocketPath, type PiAttentionState, type ZellijLocation } from "./unix-socket-transport.ts";

const publishers = new Map<string, MembershipPublisherHandle>();

/** Activates the relay publisher for each real Pi session without exposing relay identity here. */
function activatePublisher(piSessionId: string, piSessionFile: string | null): void {
  if (!piSessionId || publishers.has(piSessionId)) return;
  try {
    publishers.set(piSessionId, attachPiMembershipPublisher({ piSessionId, piSessionFile }));
  } catch {
    // A missing relay or invalid optional local configuration never prevents
    // `/channel` from writing its authoritative durable branch record.
  }
}

function activeChannels(ctx: ExtensionContext): string[] {
  const channels = new Set<string>();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== "pi-channel") continue;
    const data = entry.data as Partial<PiChannelRecord> | undefined;
    if (data?.version !== 1 || typeof data.channel !== "string") continue;
    const channel = data.channel.trim().toLowerCase();
    if (!channel) continue;
    if (data.op === "join") channels.add(channel);
    if (data.op === "leave") channels.delete(channel);
  }
  return [...channels].sort();
}

async function sessionPublisher(ctx: ExtensionContext): Promise<MembershipPublisherHandle | undefined> {
  const piSessionFile = await canonicalPiSessionFile(ctx.sessionManager);
  const piSessionId = piSessionIdentity(ctx.sessionManager, piSessionFile);
  if (!piSessionId) return undefined;
  activatePublisher(piSessionId, piSessionFile);
  return publishers.get(piSessionId);
}

async function publishMembership(ctx: ExtensionContext, channels: readonly string[]): Promise<void> {
  const piSessionFile = await canonicalPiSessionFile(ctx.sessionManager);
  const piSessionId = piSessionIdentity(ctx.sessionManager, piSessionFile);
  if (!piSessionId) return;
  activatePublisher(piSessionId, piSessionFile);
  publishPiMembership({ piSessionId, piSessionFile, channels });
}

/** Uses only inherited Zellij coordinates; no tab or terminal content is read. */
export function zellijLocationFromEnvironment(): ZellijLocation | null {
  const sessionName = process.env.ZELLIJ_SESSION_NAME;
  const paneId = process.env.ZELLIJ_PANE_ID;
  if (!sessionName || !/^\d+$/.test(paneId ?? "")) return null;
  const parsedPaneId = Number(paneId);
  return Number.isSafeInteger(parsedPaneId) && parsedPaneId >= 0 ? { sessionName, paneId: parsedPaneId } : null;
}

async function publishAttention(ctx: ExtensionContext, state: PiAttentionState): Promise<void> {
  const publisher = await sessionPublisher(ctx);
  if (!publisher) return;
  try {
    await publisher.attention(state, zellijLocationFromEnvironment());
  } catch {
    // The optional local relay cannot block Pi agent lifecycle events.
  }
}

/** JSON is deliberate: it makes a support capture complete while excluding the capability. */
async function publisherDiagnostic(ctx: ExtensionContext): Promise<string> {
  const publisher = await sessionPublisher(ctx);
  const diagnostic = publisher?.diagnostic();
  if (diagnostic) return JSON.stringify(diagnostic);
  let socketPath: string | null = null;
  try { socketPath = configuredUnixChannelSocketPath(); } catch { /* report the configuration failure below */ }
  return JSON.stringify({
    socketPath,
    connection: "disconnected",
    lastPublish: null,
    lastError: socketPath ? "local publisher is unavailable" : "local publisher socket configuration is invalid",
  });
}

/** Durable `/channel` membership is primitive Pi session state only. */
export default function piChannel(pi: ExtensionAPI) {
  // The durable entry remains Pi-owned; this is display-only and never projects relay data.
  pi.registerEntryRenderer?.<PiChannelRecord>("pi-channel", entry => new Text(channelTranscriptSummary(entry.data), 0, 0));

  // The local publisher sends only primitive snapshots; the relay owns any
  // verified Pi-to-stock-Oppi association and remains independent of this command.
  pi.on?.("session_start", async (_event, ctx) => {
    await publishMembership(ctx, activeChannels(ctx));
  });
  pi.on?.("agent_start", async (_event, ctx) => {
    await publishAttention(ctx, "active");
  });
  pi.on?.("agent_settled", async (_event, ctx) => {
    await publishAttention(ctx, "waiting");
  });
  pi.on?.("session_shutdown", async (_event, ctx) => {
    await publishAttention(ctx, "cleared");
  });

  pi.registerCommand("channel", {
    description: "Join, leave, list, or diagnose durable Pi data channels",
    getArgumentCompletions: prefix => ["join", "leave", "list", "diagnostics"].filter(value => value.startsWith(prefix.trim())).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      const command = parseChannelCommand(args);
      if (command.action === "list") {
        ctx.ui.notify(activeChannels(ctx).join(", ") || "No active channels", "info");
        return;
      }
      if (command.action === "diagnostics") {
        ctx.ui.notify(await publisherDiagnostic(ctx), "info");
        return;
      }
      pi.appendEntry("pi-channel", channelRecord(command.action, command.channel!, "pi-channel"));
      // The durable branch is authoritative. Include this just-appended operation because
      // some Pi session managers expose the branch before their append is observable.
      const channels = new Set(activeChannels(ctx));
      const channel = command.channel!.trim().toLowerCase();
      if (command.action === "join") channels.add(channel); else channels.delete(channel);
      await publishMembership(ctx, [...channels].sort());
      ctx.ui.notify(`${command.action === "join" ? "Joined" : "Left"} channel ${channel}`, "info");
    },
  });
}
