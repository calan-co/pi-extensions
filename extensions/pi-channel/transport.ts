export interface ChannelEvent<T = unknown> {
  version: 1;
  kind: "channel.event";
  eventId: string;
  channel: string;
  subject?: string;
  payload: T;
}

/** Transport adapters deliver events; durable membership remains in pi-channel trace records. */
export interface ChannelPublisher {
  publish(event: ChannelEvent): Promise<void>;
}

export interface ChannelSubscriber {
  subscribe(channels: readonly string[], onEvent: (event: ChannelEvent) => void): () => void;
}

/** Validates an event at an adapter boundary without changing its payload. */
export function channelEvent<T>(event: ChannelEvent<T>): ChannelEvent<T> {
  const { subject: rawSubject, ...rest } = event;
  const eventId = event.eventId.trim();
  if (!eventId) throw new Error("channel event ID is required");
  const channel = event.channel.trim().toLowerCase();
  if (!channel) throw new Error("channel event channel is required");
  const subject = rawSubject?.trim();
  return {
    ...rest,
    eventId,
    channel,
    ...(subject ? { subject } : {}),
  };
}

/** Publishes through an injected adapter; pi-channel itself owns no process transport. */
export function publishChannelEvent<T>(
  publisher: ChannelPublisher,
  event: ChannelEvent<T>,
): Promise<void> {
  return publisher.publish(channelEvent(event));
}

/** Deterministic local adapter for extension tests; not a cross-process transport. */
export class InProcessChannelTransport implements ChannelPublisher, ChannelSubscriber {
  private readonly subscriptions = new Set<{ channels: Set<string>; onEvent: (event: ChannelEvent) => void }>();

  async publish(event: ChannelEvent): Promise<void> {
    const normalized = channelEvent(event);
    for (const subscription of this.subscriptions) {
      if (subscription.channels.has(normalized.channel)) subscription.onEvent(normalized);
    }
  }

  subscribe(channels: readonly string[], onEvent: (event: ChannelEvent) => void): () => void {
    const subscription = { channels: new Set(channels.map(channel => channel.trim().toLowerCase()).filter(Boolean)), onEvent };
    this.subscriptions.add(subscription);
    return () => this.subscriptions.delete(subscription);
  }
}
