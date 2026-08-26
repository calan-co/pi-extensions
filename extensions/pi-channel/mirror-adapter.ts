import { currentPiMembership, subscribePiMembership, type PiMembershipSnapshot } from "./membership-source.ts";
import { UnixChannelPublisher, type UnixChannelPublisherDiagnostic } from "./unix-socket-transport.ts";

export interface PiMembershipAssociation {
  /** Stable public Pi session identifier supplied by the Pi runtime. */
  piSessionId: string;
  /** Canonical Pi session-file path, or null when unavailable. */
  piSessionFile: string | null;
}

export interface MembershipPublisher {
  snapshot(channels: readonly string[], piSessionFile: string | null): Promise<void>;
  close?(): void;
  diagnostic?(): UnixChannelPublisherDiagnostic;
}

export interface MembershipPublisherHandle {
  /** Wait for membership work queued before this call. Useful at lifecycle shutdown/tests. */
  flush(): Promise<void>;
  close(): void;
  /** Safe-to-display publisher state; it never contains the socket capability. */
  diagnostic(): UnixChannelPublisherDiagnostic | null;
}

/**
 * Attaches any enabled lifecycle to primitive, branch-derived Pi membership.
 * This boundary deliberately accepts no Oppi identity: association is resolved
 * and persisted by the relay (automatic verified metadata or `bind`).
 */
export function attachPiMembershipPublisher(
  association: PiMembershipAssociation,
  publisher: MembershipPublisher = new UnixChannelPublisher(association),
): MembershipPublisherHandle {
  let closed = false;
  let pending = Promise.resolve();
  const publish = (snapshot: PiMembershipSnapshot): Promise<void> => {
    pending = pending.catch(() => undefined).then(async () => {
      if (!closed) await publisher.snapshot(snapshot.channels, snapshot.piSessionFile);
    });
    return pending;
  };
  const receive = (snapshot: PiMembershipSnapshot) => {
    if (snapshot.piSessionId === association.piSessionId) return publish(snapshot);
  };
  const unsubscribe = subscribePiMembership(receive);
  const existing = currentPiMembership(association.piSessionId);
  if (existing) void publish(existing).catch(() => {});

  return {
    flush: () => pending,
    diagnostic: () => publisher.diagnostic?.() ?? null,
    close: () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      publisher.close?.();
    },
  };
}
