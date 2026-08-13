import { config } from "./config";
import { dbCollections, type TournamentDoc } from "./db";

const compact = (address: string) =>
  `${address.slice(0, 6)}…${address.slice(-4)}`;

/**
 * Map a participant address to their leaderboard username when one exists,
 * otherwise a compact address — avoids leaking that a row may not exist yet.
 */
export async function resolveUsername(address: string): Promise<string> {
  const leaderboard = await dbCollections().leaderboard();
  const row = await leaderboard.findOne({ _id: address });
  return row ? row.username : compact(address);
}

/** When an Open lobby expires (lobbyTimeout after open) if unmatched/unsolved. */
export function openExpiresAt(t: TournamentDoc): number {
  return t.openedAt + config.lobbyTimeoutSeconds;
}

/** When a Locked match expires (matchTimeout after lock) if unsettled. */
export function matchExpiresAt(t: TournamentDoc): number {
  return (t.lockedAt ?? t.openedAt) + config.matchTimeoutSeconds;
}

export interface PublicLobby {
  id: number;
  status: "Open" | "Locked" | "Settled" | "Refunded";
  playerA: string;
  playerB: string | null;
  stakeA: string;
  stakeB: string | null;
  serviced: boolean;
  openedAt: number;
  lockedAt: number | null;
  expiresAt: number;
}

export async function getPublicLobby(id: number): Promise<PublicLobby | null> {
  const tournaments = await dbCollections().tournaments();
  const t = await tournaments.findOne({ _id: id });
  if (!t) return null;
  return {
    id: t._id,
    status: t.status,
    playerA: t.playerA,
    playerB: t.playerB,
    stakeA: t.stakeA,
    stakeB: t.stakeB,
    serviced: t.serviced,
    openedAt: t.openedAt,
    lockedAt: t.lockedAt,
    expiresAt: t.status === "Open" ? openExpiresAt(t) : matchExpiresAt(t),
  };
}

export async function listOpenLobbies(limit = 50): Promise<PublicLobby[]> {
  const tournaments = await dbCollections().tournaments();
  return tournaments
    .find({ status: "Open", serviced: { $ne: false } })
    .sort({ _id: -1 })
    .limit(limit)
    .toArray()
    .then((rows) => rows.map(toPublicLobby));
}

/** Matched, not yet ended: status Locked, still serviced. */
export async function listActiveLobbies(limit = 50): Promise<PublicLobby[]> {
  const tournaments = await dbCollections().tournaments();
  return tournaments
    .find({ status: "Locked", serviced: { $ne: false } })
    .sort({ _id: -1 })
    .limit(limit)
    .toArray()
    .then((rows) => rows.map(toPublicLobby));
}

function toPublicLobby(t: TournamentDoc): PublicLobby {
  return {
    id: t._id,
    status: t.status,
    playerA: t.playerA,
    playerB: t.playerB,
    stakeA: t.stakeA,
    stakeB: t.stakeB,
    serviced: t.serviced,
    openedAt: t.openedAt,
    lockedAt: t.lockedAt,
    expiresAt: t.status === "Open" ? openExpiresAt(t) : matchExpiresAt(t),
  };
}
export function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
