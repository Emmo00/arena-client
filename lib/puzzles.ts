import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config";
import { dbCollections, type PuzzleDoc } from "./db";
import { fixturePuzzles } from "./fixtures";

type RawPuzzle = {
  puzzleid: string;
  fen: string;
  moves: string[];
  rating: number;
  ratingdeviation: number;
  popularity: number;
  themes: string[];
  "opening tags"?: string[];
  cost?: number;
};

function normalize(raw: RawPuzzle): Omit<PuzzleDoc, "generation"> {
  return {
    _id: raw.puzzleid,
    fen: raw.fen,
    moves: raw.moves,
    rating: raw.rating,
    ratingdeviation: raw.ratingdeviation,
    popularity: raw.popularity,
    themes: raw.themes ?? [],
    openingTags: raw["opening tags"] ?? [],
    cost: raw.cost ?? 0,
  };
}

export async function getCurrentGeneration(): Promise<number> {
  const puzzles = await dbCollections().puzzles();
  const top = await puzzles.find({}).sort({ generation: -1 }).limit(1).toArray();
  return top[0]?.generation ?? 0;
}

export async function currentPuzzleCount(): Promise<number> {
  const gen = await getCurrentGeneration();
  if (gen === 0) return 0;
  return dbCollections().puzzles().then((c) => c.countDocuments({ generation: gen }));
}

export async function getPuzzleById(id: string): Promise<PuzzleDoc | null> {
  return dbCollections().puzzles().then((c) => c.findOne({ _id: id }));
}

/** Sample `count` unique puzzle ids from the current cache generation. */
export async function sampleSubset(count: number): Promise<string[]> {
  const gen = await getCurrentGeneration();
  if (gen === 0) return [];
  const puzzles = await dbCollections().puzzles();
  const docs = await puzzles
    .aggregate([{ $match: { generation: gen } }, { $sample: { size: count } }])
    .toArray();
  return docs.map((d) => d._id);
}

async function fetchFromApiViaX402(count: number): Promise<RawPuzzle[]> {
  const account = privateKeyToAccount(config.appWalletPrivateKey as `0x${string}`);
  const client = new x402Client().register(
    "eip155:42220",
    new ExactEvmScheme(account, { rpcUrl: config.celoRpcUrl })
  );
  const payFetch = wrapFetchWithPayment(fetch, client);

  const url = `${config.chesspuzzlesApiBase}/puzzles?count=${count}`;
  const res = await payFetch(url, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`chesspuzzles x402 fetch failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { puzzles?: RawPuzzle[] };
  if (!Array.isArray(data.puzzles)) {
    throw new Error("chesspuzzles response missing puzzles[]");
  }
  return data.puzzles;
}

async function bulkInsert(docs: Array<Omit<PuzzleDoc, "generation">>, generation: number) {
  const puzzles = await dbCollections().puzzles();
  if (docs.length === 0) return;
  await puzzles.bulkWrite(
    docs.map((d) => ({
      replaceOne: {
        filter: { _id: d._id },
        replacement: { ...d, generation } as PuzzleDoc,
        upsert: true,
      },
    })),
    { ordered: false }
  );
}

/** Delete stale generations that are not referenced by any active tournament. */
async function pruneOldGenerations(currentGen: number) {
  if (currentGen <= 1) return;
  const tournaments = await dbCollections().tournaments();
  const active = await tournaments
    .find({ status: { $in: ["Open", "Locked"] } })
    .project({ puzzleSubset: 1 })
    .toArray();
  const referenced = new Set(active.flatMap((t) => t.puzzleSubset ?? []));
  const puzzles = await dbCollections().puzzles();
  await puzzles.deleteMany({
    generation: { $lt: currentGen },
    _id: { $nin: [...referenced] },
  });
}

/**
 * Refill the puzzle pool into a brand-new generation (full replace). Uses paid
 * x402 fetching when an app wallet key is configured, otherwise seeds from local
 * fixtures (dev/test only). Never deletes puzzles still referenced by an
 * in-progress (Open/Locked) tournament.
 */
export async function refreshCache(): Promise<{ mode: "x402" | "fixtures"; inserted: number }> {
  const currentGen = await getCurrentGeneration();
  const nextGen = currentGen + 1;

  if (config.appWalletPrivateKey) {
    try {
      const per = 100; // API clamps count to 100
      const batches = Math.ceil(config.puzzleCacheSize / per);
      const docs: Array<Omit<PuzzleDoc, "generation">> = [];
      for (let i = 0; i < batches; i++) {
        const raw = await fetchFromApiViaX402(per);
        docs.push(...raw.map(normalize));
      }
      await bulkInsert(docs, nextGen);
      await pruneOldGenerations(nextGen);
      return { mode: "x402", inserted: docs.length };
    } catch (e) {
      console.error("[cache] x402 refresh failed, falling back to fixtures:", e);
    }
  }

  const docs: Array<Omit<PuzzleDoc, "generation">> = fixturePuzzles.map((f) => ({
    _id: f.puzzleid,
    fen: f.fen,
    moves: f.moves,
    rating: f.rating,
    ratingdeviation: f.ratingdeviation,
    popularity: f.popularity,
    themes: f.themes,
    openingTags: f.openingTags,
    cost: f.cost,
  }));
  await bulkInsert(docs, nextGen);
  await pruneOldGenerations(nextGen);
  return { mode: "fixtures", inserted: docs.length };
}

// ------------------------------------------------------------------ helpers

/** Number of moves the solving side must find (informational). */
export function playerMovesOf(moves: string[]): number {
  return Math.ceil(moves.length / 2);
}

export function isCorrectMove(submitted: string, solution: string[]): boolean {
  const first = solution[0]?.trim();
  return first !== undefined && submitted.trim().toLowerCase() === first.toLowerCase();
}
