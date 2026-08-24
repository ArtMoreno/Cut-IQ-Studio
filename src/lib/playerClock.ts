export interface PendingPlayerSeek {
  targetSeconds: number;
  expiresAtMs: number;
}

export interface ReconciledPlayerClock {
  seconds: number;
  pending: PendingPlayerSeek | null;
}

/**
 * The YouTube iframe can report its pre-seek clock for a few polling ticks.
 * Hold the requested playhead until the iframe catches up or a short safety
 * timeout expires, preventing transcript clicks from visibly snapping back.
 */
export function reconcilePlayerClock(
  rawSeconds: number,
  pending: PendingPlayerSeek | null,
  nowMs: number,
  toleranceSeconds = 0.75,
): ReconciledPlayerClock {
  const safeRaw = Number.isFinite(rawSeconds) ? Math.max(0, rawSeconds) : 0;
  if (!pending) return { seconds: safeRaw, pending: null };
  const caughtUp = Math.abs(safeRaw - pending.targetSeconds) <= toleranceSeconds;
  if (caughtUp || nowMs >= pending.expiresAtMs) return { seconds: caughtUp ? pending.targetSeconds : safeRaw, pending: null };
  return { seconds: pending.targetSeconds, pending };
}
