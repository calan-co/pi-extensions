export type ChannelOperation = "join" | "leave";

export interface PiChannelRecord {
  version: 1;
  op: ChannelOperation;
  channel: string;
  source?: string;
}

const MAX_CHANNEL_SUMMARY_CHARS = 48;

/** Projects durable channel state without exposing arbitrary custom-entry fields. */
export function channelTranscriptSummary(data: unknown): string {
  if (!data || typeof data !== "object") return "Channel membership activity";
  const record = data as Partial<PiChannelRecord>;
  if (record.version !== 1 || (record.op !== "join" && record.op !== "leave") || typeof record.channel !== "string") {
    return "Channel membership activity";
  }
  const channel = record.channel.trim().toLowerCase().replace(/[^\p{L}\p{N}._:-]/gu, "?");
  if (!channel) return "Channel membership activity";
  const display = channel.length > MAX_CHANNEL_SUMMARY_CHARS
    ? `${channel.slice(0, MAX_CHANNEL_SUMMARY_CHARS - 1)}…`
    : channel;
  return `Channel ${record.op === "join" ? "joined" : "left"}: ${display}`;
}

export function channelRecord(op: ChannelOperation, name: string, source?: string): PiChannelRecord {
  const channel = name.trim().toLowerCase();
  if (!channel) throw new Error("channel name is required");
  return { version: 1, op, channel, ...(source ? { source } : {}) };
}

export function parseChannelCommand(args: string): { action: "join" | "leave" | "list" | "diagnostics"; channel?: string } {
  const [action, channel, ...extra] = args.trim().split(/\s+/).filter(Boolean);
  if ((action === "list" || action === "diagnostics") && !channel) return { action };
  if ((action === "join" || action === "leave") && channel && extra.length === 0) return { action, channel };
  throw new Error("Usage: /channel <join|leave> <name> | /channel <list|diagnostics>");
}
