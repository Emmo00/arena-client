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

export interface MetaDoc {
  _id: string;
  value: string;
}

let client: MongoClient | null = null;
let db: Db | null = null;

async function ensureIndexes(d: Db) {
  await Promise.all([
    d.collection("nonces").createIndex({ expiresAt: 1 }),
    d.collection("tournaments").createIndex({ status: 1 }),
    d.collection("tournaments").createIndex({ playerA: 1 }),
    d.collection("tournaments").createIndex({ playerB: 1 }),
    d.collection("sessions").createIndex({ tournamentId: 1, player: 1 }, { unique: true }),
    d.collection("puzzles").createIndex({ generation: 1 }),
    d.collection("submissions").createIndex({ sessionId: 1 }),
  ]);
}

export async function getDb(): Promise<Db> {
  if (!db) {
    const c = new MongoClient(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
    await c.connect();
    client = c;
    db = c.db();
    await ensureIndexes(db);
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
  };
}
