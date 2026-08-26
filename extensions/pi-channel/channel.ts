export type ChannelOperation = "join" | "leave";

export interface PiChannelRecord {
  version: 1;
  op: ChannelOperation;
  channel: string;
  source?: string;
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
