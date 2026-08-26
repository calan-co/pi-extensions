import { realpath } from "node:fs/promises";
import { basename } from "node:path";

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface SessionIdentityManager {
  getSessionId?: () => unknown;
  getSessionFile?: () => unknown;
}

/**
 * Returns the stable Pi session ID, falling back to the canonical session-file
 * basename. Pi persists sessions as `<session-id>.jsonl`, so this preserves
 * the same association key without exposing a raw path as the source ID.
 */
export function piSessionIdentity(sessionManager: SessionIdentityManager, canonicalSessionFile?: string | null): string | undefined {
  try {
    const sessionId = sessionManager.getSessionId?.();
    if (typeof sessionId === "string" && sessionId.trim()) return sessionId.trim();
  } catch {
    // Session-file identity below preserves publication for older Pi runtimes.
  }

  let sessionFile = canonicalSessionFile;
  if (sessionFile === undefined) {
    try {
      const value = sessionManager.getSessionFile?.();
      sessionFile = typeof value === "string" && value.trim() ? value.trim() : null;
    } catch {
      sessionFile = null;
    }
  }
  const filename = sessionFile && basename(sessionFile);
  const sessionId = filename?.endsWith(".jsonl") ? filename.slice(0, -".jsonl".length) : undefined;
  return sessionId && SESSION_ID.test(sessionId) ? sessionId : undefined;
}

/**
 * Resolves the actual session file so the relay can compare one canonical path
 * with stock metadata. A raw or unavailable path is never an association key.
 */
export async function canonicalPiSessionFile(sessionManager: SessionIdentityManager): Promise<string | null> {
  try {
    const sessionFile = sessionManager.getSessionFile?.();
    if (typeof sessionFile !== "string" || !sessionFile.trim()) return null;
    return await realpath(sessionFile.trim());
  } catch {
    return null;
  }
}
