export interface PiMembershipSnapshot {
  /** Stable Pi runtime session ID; this module intentionally knows no Oppi identity. */
  piSessionId: string;
  /** Canonical local file path, or null when this Pi runtime cannot resolve one. */
  piSessionFile: string | null;
  channels: readonly string[];
}

export type PiMembershipListener = (snapshot: PiMembershipSnapshot) => void | Promise<void>;

const snapshots = new Map<string, PiMembershipSnapshot>();
const listeners = new Set<PiMembershipListener>();

/**
 * Publishes a branch-derived membership snapshot to optional local adapters.
 * Durable Pi session entries remain authoritative when no adapter is present.
 */
export function publishPiMembership(snapshot: PiMembershipSnapshot): void {
  const normalized = { piSessionId: snapshot.piSessionId, piSessionFile: snapshot.piSessionFile, channels: [...snapshot.channels] };
  snapshots.set(normalized.piSessionId, normalized);
  for (const listener of listeners) {
    Promise.resolve(listener(normalized)).catch(() => {
      // Local adapters are optional and must never make a durable command fail.
    });
  }
}

/** Returns the latest branch-derived snapshot observed for this Pi session. */
export function currentPiMembership(piSessionId: string): PiMembershipSnapshot | undefined {
  const snapshot = snapshots.get(piSessionId);
  return snapshot && { piSessionId: snapshot.piSessionId, piSessionFile: snapshot.piSessionFile, channels: [...snapshot.channels] };
}

/**
 * Adapter seam for an integration that owns an independently verified session
 * association. It is intentionally primitive-only: no Oppi identifiers cross
 * the `/channel` command boundary.
 */
export function subscribePiMembership(listener: PiMembershipListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
