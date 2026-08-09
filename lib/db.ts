import { MongoClient, type Collection, type Db, type Document, type ObjectId } from "mongodb";
import { config } from "./config";

export type TournamentStatus = "Open" | "Locked" | "Settled" | "Refunded";

export interface TournamentDoc {
  _id: number; // on-chain tournament id
  status: TournamentStatus;
  playerA: string;
  playerB: string | null;
  stakeA: string; // atomic units, string to stay safe with bigints
  stakeB: string | null;
  openedAt: number; // epoch seconds
  lockedAt: number | null;
  /** Whether the app accepted this lobby into its pool. Unserviced lobbies
   * (opened beyond MAX_OPEN_LOBBIES) are indexed but never get a puzzle subset
   * or session; their stakes are returned by refundLobby/refundLockedLobby. */
  serviced: boolean;
  generation: number | null; // puzzle cache generation the subset was sampled from
  puzzleSubset: string[]; // fixed puzzle ids for both agents
  winner: string | null;
  fee: string | null;
  settleTx: string | null;
  refundTx: string | null;
  settleAttemptedAt: number | null;
  refundAttemptedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** Single-flight guard: set once when leaderboard rows are applied, so the
   * settler and the Settled-event path can't race or replay. */
  leaderboardApplied?: boolean;
}

export interface SessionDoc {
  _id: ObjectId;
  tournamentId: number;
  player: string;
  startedAt: number; // epoch ms
  deadline: number; // epoch ms
  shuffled: string[]; // per-agent shuffled subset
  servedCount: number;
  solvedCount: number;
  ratingSum: number;
  lastSubmittedAt: number | null;
  completedAt: number | null;
}

export interface SubmissionDoc {
  _id: ObjectId;
  sessionId: ObjectId;
  puzzleId: string;
  correct: boolean;
  elapsedMs: number | null;
  submittedAt: number; // epoch ms
}

export interface PuzzleDoc {
  _id: string; // puzzleid
  fen: string;
  moves: string[]; // full solution — SERVER-ONLY, never in an HTTP response
  rating: number;
  ratingdeviation: number;
  popularity: number;
  themes: string[];
  openingTags: string[];
  cost: number;
  generation: number;
}

export interface NonceDoc {
  _id: string; // wallet address
  nonce: string;
  message: string;
  expiresAt: number; // epoch ms
}

/** One row per agent, maintained by the settlement worker (never read-computed). */
export interface LeaderboardDoc {
  _id: string; // checksummed wallet address
  username: string;
  usernameLower: string; // unique index — enforces case-insensitive uniqueness
  usernameChangedAt: number | null; // epoch ms, for the rename cooldown
  tournamentsPlayed: number;
  tournamentsWon: number;
  totalWon: number; // atomic units, sum of payouts received as winner
  totalStaked: number; // atomic units, sum of stakes across played tournaments
  netEarned: number; // totalWon - totalStaked (can be negative); sort key
  settledTournamentIds: number[]; // idempotency guard: exactly-once per tournament
  updatedAt: number;
}

export interface MetaDoc {
  _id: string;
  value: string;
}

let client: MongoClient | null = null;
let db: Db | null = null;

async function createIndexes(d: Db) {
  await Promise.all([
    d.collection("nonces").createIndex({ expiresAt: 1 }),
    d.collection("tournaments").createIndex({ status: 1 }),
    d.collection("tournaments").createIndex({ playerA: 1 }),
    d.collection("tournaments").createIndex({ playerB: 1 }),
    d.collection("sessions").createIndex({ tournamentId: 1, player: 1 }, { unique: true }),
    d.collection("puzzles").createIndex({ generation: 1 }),
    d.collection("submissions").createIndex({ sessionId: 1 }),
    d.collection("leaderboard").createIndex({ usernameLower: 1 }, { unique: true }),
    d.collection("leaderboard").createIndex({ netEarned: -1, tournamentsPlayed: -1, username: 1 }),
  ]);
}

/** (Re)create collection indexes on the current connection. Safe to call again
 * after a dropDatabase() (e.g. test harnesses) — createIndex is a no-op when
 * the index already exists. */
export async function ensureIndexes(): Promise<void> {
  const d = await getDb();
  await createIndexes(d);
}

export async function getDb(): Promise<Db> {
  if (!db) {
    const c = new MongoClient(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
    await c.connect();
    client = c;
    db = c.db();
    await createIndexes(db);
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

export async function getCol<T extends Document>(name: string): Promise<Collection<T>> {
  return (await getDb()).collection<T>(name);
}

export function dbCollections() {
  return {
    meta: () => getCol<MetaDoc>("meta"),
    nonces: () => getCol<NonceDoc>("nonces"),
    puzzles: () => getCol<PuzzleDoc>("puzzles"),
    tournaments: () => getCol<TournamentDoc>("tournaments"),
    sessions: () => getCol<SessionDoc>("sessions"),
    submissions: () => getCol<SubmissionDoc>("submissions"),
    leaderboard: () => getCol<LeaderboardDoc>("leaderboard"),
  };
}
