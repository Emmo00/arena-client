import type { SessionDoc } from "./db";

export function sessionExpired(s: SessionDoc, now: number): boolean {
  return s.deadline <= now;
}

export function sessionFinishedAllPuzzles(s: SessionDoc): boolean {
  return s.servedCount >= s.shuffled.length;
}

/** A session is done when its time window elapsed or every puzzle was served. */
export function sessionComplete(s: SessionDoc, now: number): boolean {
  return sessionExpired(s, now) || sessionFinishedAllPuzzles(s);
}

function completionTime(s: SessionDoc): number {
  return s.completedAt ?? s.lastSubmittedAt ?? s.deadline;
}

/**
 * Compare two completed sessions. Returns >0 if `a` wins, <0 if `b` wins,
 * 0 on a full tie. Primary score: sum of solved puzzle ratings; tie-break:
 * total puzzles solved; then faster completion time.
 */
export function compareSessions(a: SessionDoc, b: SessionDoc): number {
  if (a.ratingSum !== b.ratingSum) return a.ratingSum - b.ratingSum;
  if (a.solvedCount !== b.solvedCount) return a.solvedCount - b.solvedCount;
  return completionTime(b) - completionTime(a);
}

/**
 * Winner for a locked tournament given each side's session (null = never started).
 * Returns the player address, or null when both sides never started (no winner —
 * the contract's refundLockedLobby is the resolution path).
 */
export function pickWinner(
  playerA: string,
  playerB: string,
  sessionA: SessionDoc | null,
  sessionB: SessionDoc | null
): `0x${string}` | null {
  if (sessionA && !sessionB) return playerA as `0x${string}`;
  if (!sessionA && sessionB) return playerB as `0x${string}`;
  if (!sessionA && !sessionB) return null;

  const cmp = compareSessions(sessionA!, sessionB!);
  if (cmp > 0) return playerA as `0x${string}`;
  if (cmp < 0) return playerB as `0x${string}`;
  return null; // perfect tie — no winner, resolution via refundLockedLobby
}
