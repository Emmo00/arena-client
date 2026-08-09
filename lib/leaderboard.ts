import { getAddress } from "viem";
import { config } from "./config";
import { dbCollections, type LeaderboardDoc } from "./db";
import { generateUsername, normalizeUsername, validateUsername } from "./usernames";

/** Framework-agnostic error; routes translate it to an HTTP response. */
export class LeaderboardError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface LeaderboardItem {
  rank: number;
  username: string;
  address: string;
  netEarned: string; // atomic units; can be negative
  tournamentsPlayed: number;
  tournamentsWon: number;
}

export interface SearchResult {
  rank: number;
  username: string;
  address: string;
  netEarned: string;
}

export interface RecentMatch {
  tournamentId: number;
  opponentUsername: string;
  result: "win" | "loss";
  netChange: string; // atomic units; negative for losses
}

export interface UserProfile {
  username: string;
  address: string;
  netEarned: string;
  totalWon: string;
  totalStaked: string;
  tournamentsPlayed: number;
  tournamentsWon: number;
  rank: number;
  recentMatches: RecentMatch[];
}

// Sort order defines ranking AND the keyset pagination cursor. netEarned DESC,
// tournamentsPlayed DESC, username ASC (case-sensitive; unique per the
// usernameLower unique index, so ties below netEarned/played are impossible).
const SORT = { netEarned: -1, tournamentsPlayed: -1, username: 1 } as const;

const isDuplicateKey = (e: unknown) =>
  typeof e === "object" && e !== null && (e as { code?: number }).code === 11000;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function generateUniqueUsername(): Promise<string> {
  const leaderboard = await dbCollections().leaderboard();
  for (let i = 0; i < 20; i++) {
    const candidate = generateUsername();
    const taken = await leaderboard.findOne({ usernameLower: normalizeUsername(candidate) });
    if (!taken) return candidate;
  }
  return `${generateUsername()}-${Date.now().toString(36)}`;
}

const DEFAULT_DOC = (username: string) => ({
  username,
  usernameLower: normalizeUsername(username),
  usernameChangedAt: null as number | null,
  tournamentsPlayed: 0,
  tournamentsWon: 0,
  totalWon: 0,
  totalStaked: 0,
  netEarned: 0,
  settledTournamentIds: [] as number[],
  updatedAt: Date.now(),
});

/**
 * Ensure a leaderboard row exists for `address`. On first call the row is created
 * with the requested username (if valid) or a random unique one; on every later
 * call (subsequent sign-ins) the stored username is returned and `requested` is
 * ignored — a wallet's username is fixed at first verify.
 */
export async function ensureUser(
  addressRaw: string,
  requested?: string
): Promise<{ username: string }> {
  const address = getAddress(addressRaw);
  const leaderboard = await dbCollections().leaderboard();
  const existing = await leaderboard.findOne({ _id: address });
  if (existing) return { username: existing.username };

  const requestedValid = typeof requested === "string" && validateUsername(requested);
  const candidate = requestedValid ? requested : await generateUniqueUsername();

  try {
    await leaderboard.updateOne(
      { _id: address },
      { $setOnInsert: DEFAULT_DOC(candidate) },
      { upsert: true }
    );
    return { username: candidate };
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    // A concurrent sign-in for this address won, or the username was taken by a
    // different address. Re-read; fall back to an auto name.
    const row = await leaderboard.findOne({ _id: address });
    if (row) return { username: row.username };
    return ensureUser(address);
  }
}

/** Rename the profile for `address`. Fails with a cooldown, invalid, or taken error. */
export async function renameUser(
  addressRaw: string,
  username: string
): Promise<{ username: string }> {
  const address = getAddress(addressRaw);
  if (!validateUsername(username)) {
    throw new LeaderboardError(
      400,
      "USERNAME_INVALID",
      `Username must be ${config.usernameMinLength}-${config.usernameMaxLength} chars, [a-zA-Z0-9_-]`
    );
  }
  const leaderboard = await dbCollections().leaderboard();
  const row = await leaderboard.findOne({ _id: address });
  if (!row) throw new LeaderboardError(404, "NOT_FOUND", "Profile not found");

  const now = Date.now();
  const cooldownMs = config.usernameChangeCooldownHours * 3600 * 1000;
  if (row.usernameChangedAt !== null && now - row.usernameChangedAt < cooldownMs) {
    throw new LeaderboardError(
      429,
      "USERNAME_CHANGE_COOLDOWN",
      "Username changes are rate-limited"
    );
  }

  try {
    await leaderboard.updateOne(
      { _id: address },
      {
        $set: {
          username,
          usernameLower: normalizeUsername(username),
          usernameChangedAt: now,
          updatedAt: now,
        },
      }
    );
    return { username };
  } catch (e) {
    if (isDuplicateKey(e)) {
      throw new LeaderboardError(409, "USERNAME_TAKEN", "Username already taken");
    }
    throw e;
  }
}

type SettlementInc = Partial<
  Pick<LeaderboardDoc, "tournamentsPlayed" | "tournamentsWon" | "totalWon" | "totalStaked" | "netEarned">
>;

async function applySettlementTo(
  addressRaw: string,
  tournamentId: number,
  inc: SettlementInc
): Promise<void> {
  const address = getAddress(addressRaw);
  // Row may not exist yet (never-signed-in agent that just settled). Ensure it
  // with an auto username, then apply the atomic, guard-protected increment.
  await ensureUser(address);
  const leaderboard = await dbCollections().leaderboard();
  await leaderboard.updateOne(
    { _id: address, settledTournamentIds: { $ne: tournamentId } },
    {
      $push: { settledTournamentIds: tournamentId },
      $inc: inc,
      $set: { updatedAt: Date.now() },
    }
  );
}

/**
 * Credit/debit leaderboard rows for a settled tournament. Called by both the
 * settler worker (right after a successful settle tx) and the Settled-event
 * path (webhook/indexer). Exactly-once is guaranteed by two guards:
 *   - leaderboardApplied single-flight on the tournament doc (atomic claim), and
 *   - settledTournamentIds membership on each player row.
 */
export async function recordSettlement(
  tournamentId: number,
  winnerRaw: string,
  fee: number
): Promise<void> {
  const tournaments = await dbCollections().tournaments();
  const winner = getAddress(winnerRaw);

  const t = await tournaments.findOne({ _id: tournamentId });
  if (!t) return;
  if (!t.playerA || !t.playerB) return;
  const stakeA = Number(t.stakeA);
  const stakeB = t.stakeB ? Number(t.stakeB) : stakeA;
  const pot = stakeA + stakeB;
  const feeN = Number(fee);

  const isWinnerA = getAddress(t.playerA) === winner;
  const isWinnerB = getAddress(t.playerB) === winner;
  if (!isWinnerA && !isWinnerB) return; // winner not a participant; don't corrupt
  const winnerStake = isWinnerA ? stakeA : stakeB;
  const loser = isWinnerA ? t.playerB : t.playerA;

  await applySettlementTo(winner, tournamentId, {
    tournamentsPlayed: 1,
    tournamentsWon: 1,
    totalWon: pot - feeN,
    totalStaked: winnerStake,
    netEarned: pot - feeN - winnerStake,
  });
  await applySettlementTo(loser, tournamentId, {
    tournamentsPlayed: 1,
    totalStaked: pot - winnerStake,
    netEarned: -(pot - winnerStake),
  });

  // Mark fully processed LAST. If a caller crashes after applying rows but
  // before this write, a retry re-runs the applies — the settledTournamentIds
  // $ne guard makes those no-ops for committed rows, so exactly-once holds.
  await tournaments.updateOne(
    { _id: tournamentId, leaderboardApplied: { $ne: true } },
    { $set: { leaderboardApplied: true, updatedAt: Date.now() } }
  );
}

async function computeRank(
  row: Pick<LeaderboardDoc, "netEarned" | "tournamentsPlayed" | "username">
): Promise<number> {
  const leaderboard = await dbCollections().leaderboard();
  const ahead = await leaderboard.countDocuments({
    $or: [
      { netEarned: { $gt: row.netEarned } },
      { netEarned: row.netEarned, tournamentsPlayed: { $gt: row.tournamentsPlayed } },
      { netEarned: row.netEarned, tournamentsPlayed: row.tournamentsPlayed, username: { $lt: row.username } },
    ],
  });
  return ahead + 1;
}

type Cursor = { netEarned: number; tournamentsPlayed: number; username: string };

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.netEarned, c.tournamentsPlayed, c.username])).toString(
    "base64url"
  );
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const arr: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      Array.isArray(arr) &&
      arr.length === 3 &&
      typeof arr[0] === "number" &&
      typeof arr[1] === "number" &&
      typeof arr[2] === "string"
    ) {
      return { netEarned: arr[0], tournamentsPlayed: arr[1], username: arr[2] };
    }
  } catch {
    // fall through
  }
  return null;
}

/** Keyset-paginated leaderboard page. Returns null for an invalid cursor. */
export async function getLeaderboardPage(
  cursorRaw?: string,
  limit?: number
): Promise<{ items: LeaderboardItem[]; nextCursor: string | null } | null> {
  const leaderboard = await dbCollections().leaderboard();
  const pageSize = Math.min(
    Math.max(1, Math.floor(limit ?? config.leaderboardPageSize)),
    config.leaderboardPageSize
  );

  const cursor = cursorRaw ? decodeCursor(cursorRaw) : undefined;
  if (cursorRaw && !cursor) return null;

  const filter: Record<string, unknown> = {};
  if (cursor) {
    filter.$or = [
      { netEarned: { $lt: cursor.netEarned } },
      { netEarned: cursor.netEarned, tournamentsPlayed: { $lt: cursor.tournamentsPlayed } },
      {
        netEarned: cursor.netEarned,
        tournamentsPlayed: cursor.tournamentsPlayed,
        username: { $gt: cursor.username },
      },
    ];
  }

  const rows = await leaderboard
    .find(filter)
    .sort(SORT)
    .limit(pageSize + 1)
    .toArray();
  const hasMore = rows.length > pageSize;
  const pageRows = rows.slice(0, pageSize);

  const items: LeaderboardItem[] = [];
  if (pageRows.length > 0) {
    const baseRank = await computeRank(pageRows[0]);
    pageRows.forEach((r, i) => {
      items.push({
        rank: baseRank + i,
        username: r.username,
        address: r._id,
        netEarned: String(r.netEarned),
        tournamentsPlayed: r.tournamentsPlayed,
        tournamentsWon: r.tournamentsWon,
      });
    });
  }

  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({
          netEarned: last.netEarned,
          tournamentsPlayed: last.tournamentsPlayed,
          username: last.username,
        })
      : null;

  return { items, nextCursor };
}

/** Case-insensitive substring search over usernames, ranked live. */
export async function searchUsers(qRaw: string, limit = 10): Promise<SearchResult[]> {
  const q = qRaw.trim();
  if (!q) return [];
  const leaderboard = await dbCollections().leaderboard();
  const rows = await leaderboard
    .find({ usernameLower: { $regex: escapeRegExp(q.toLowerCase()) } })
    .sort(SORT)
    .limit(Math.max(1, Math.min(limit, 10)))
    .toArray();
  const results: SearchResult[] = [];
  for (const r of rows) {
    results.push({
      rank: await computeRank(r),
      username: r.username,
      address: r._id,
      netEarned: String(r.netEarned),
    });
  }
  return results;
}

/** Public profile by username (case-insensitive). Null when not found. */
export async function getUserByUsername(usernameRaw: string): Promise<UserProfile | null> {
  const leaderboard = await dbCollections().leaderboard();
  const row = await leaderboard.findOne({ usernameLower: normalizeUsername(usernameRaw.trim()) });
  if (!row) return null;
  return {
    username: row.username,
    address: row._id,
    netEarned: String(row.netEarned),
    totalWon: String(row.totalWon),
    totalStaked: String(row.totalStaked),
    tournamentsPlayed: row.tournamentsPlayed,
    tournamentsWon: row.tournamentsWon,
    rank: await computeRank(row),
    recentMatches: await getUserMatches(row._id),
  };
}

/** Recent settled matches for an address (winner/loser resolved by address). */
export async function getUserMatches(addressRaw: string, limit = 5): Promise<RecentMatch[]> {
  const address = getAddress(addressRaw);
  const leaderboard = await dbCollections().leaderboard();
  const row = await leaderboard.findOne({ _id: address });
  if (!row) return [];

  const tournaments = await dbCollections().tournaments();
  const ids = row.settledTournamentIds.slice(-limit).reverse();
  const matches: RecentMatch[] = [];
  for (const id of ids) {
    const t = await tournaments.findOne({ _id: id });
    if (!t || t.status !== "Settled" || !t.playerA || !t.playerB || !t.winner) continue;
    const me = getAddress(row._id);
    const isWinner = getAddress(t.winner) === me;
    const opponent = getAddress(t.playerA) === me ? t.playerB : t.playerA;
    const opp = await leaderboard.findOne({ _id: opponent });
    const ownStake = getAddress(t.playerA) === me ? Number(t.stakeA) : Number(t.stakeB ?? t.stakeA);
    const pot = Number(t.stakeA) + Number(t.stakeB ?? t.stakeA);
    const fee = t.fee ? Number(t.fee) : 0;
    const netChange = isWinner ? pot - fee - ownStake : -ownStake;
    matches.push({
      tournamentId: id,
      opponentUsername: opp?.username ?? opponent,
      result: isWinner ? "win" : "loss",
      netChange: String(netChange),
    });
  }
  return matches;
}
