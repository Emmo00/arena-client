import { Chess } from "chess.js";
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

async function fetchFromApi(count: number): Promise<RawPuzzle[]> {
  const url = `${config.chesspuzzlesApiBase}/puzzles?playerMoves=1&count=${count}`;
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "x-api-key": config.chesspuzzlesApiKey,
    },
  });
  if (!res.ok) {
    throw new Error(`chesspuzzles API fetch failed: ${res.status} ${res.statusText}`);
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
 * Refill the puzzle pool into a brand-new generation (full replace). Uses the
 * chesspuzzles API (x-api-key) when a key is configured, otherwise seeds from
 * local fixtures (dev/test only). Never deletes puzzles still referenced by an
 * in-progress (Open/Locked) tournament.
 */
export async function refreshCache(): Promise<{ mode: "api" | "fixtures"; inserted: number }> {
  const currentGen = await getCurrentGeneration();
  const nextGen = currentGen + 1;

  if (config.chesspuzzlesApiKey) {
    try {
      const per = 100; // API clamps count to 100
      const batches = Math.ceil(config.puzzleCacheSize / per);
      const docs: Array<Omit<PuzzleDoc, "generation">> = [];
      for (let i = 0; i < batches; i++) {
        const raw = await fetchFromApi(per);
        docs.push(...raw.map(normalize));
      }
      await bulkInsert(docs, nextGen);
      await pruneOldGenerations(nextGen);
      return { mode: "api", inserted: docs.length };
    } catch (e) {
      console.error("[cache] API refresh failed, falling back to fixtures:", e);
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

// ------------------------------------------------------------- refresh state

export async function getLastCacheRefresh(): Promise<number> {
  const meta = await dbCollections().meta();
  const doc = await meta.findOne({ _id: "cache_last_refresh" });
  return doc ? Number(doc.value) : 0;
}

export async function setLastCacheRefresh(ts: number) {
  const meta = await dbCollections().meta();
  await meta.updateOne(
    { _id: "cache_last_refresh" },
    { $set: { value: String(ts) } },
    { upsert: true }
  );
}

/**
 * Refresh the puzzle pool if it is due (schedule) or running low (pool < size).
 * Used by the cache worker and by the token-protected /cache/refresh endpoint
 * (which a GitHub Actions cron can hit instead of running a worker).
 */
export async function maybeRefreshCache(): Promise<{
  refreshed: boolean;
  mode: "api" | "fixtures";
  inserted: number;
  pool: number;
}> {
  const count = await currentPuzzleCount();
  const last = await getLastCacheRefresh();
  const due = Date.now() - last >= config.puzzleCacheRefreshHours * 3600 * 1000;
  const low = count < config.puzzlePoolSize;
  if (!due && !low) return { refreshed: false, mode: "fixtures", inserted: 0, pool: count };
  const { mode, inserted } = await refreshCache();
  await setLastCacheRefresh(Date.now());
  return { refreshed: true, mode, inserted, pool: (await currentPuzzleCount()) };
}

// ------------------------------------------------------------------ helpers

/** Side to move from a FEN (field 1: "w" | "b"). */
function sideToMove(fen: string): "w" | "b" {
  const turn = fen.trim().split(/\s+/)[1];
  return turn === "b" ? "b" : "w";
}

/** Number of moves the solving side must find (informational). */
export function playerMovesOf(moves: string[], fen?: string): number {
  if (!fen || moves.length === 0) return Math.ceil(moves.length / 2);
  return sideToMove(fen) === "w" ? Math.ceil(moves.length / 2) : Math.floor(moves.length / 2);
}

/**
 * Whether the submitted move is the puzzle's first solution move. Both the
 * stored solution and the submission are normalized through chess.js against
 * the puzzle FEN, so equivalent notation is accepted (e.g. "Qh5" for "Qh5+",
 * "exd6" for "exd6 e.p.", "e8Q" for "e8=Q") while any other legal move is
 * rejected. Falls back to a plain string compare when no FEN is given.
 */
export function isCorrectMove(submitted: string, solution: string[], fen?: string): boolean {
  const first = solution[0]?.trim();
  if (!first) return false;

  if (!fen) return submitted.trim().toLowerCase() === first.toLowerCase();

  try {
    const expected = new Chess(fen).move(first)?.san;
    if (!expected) return false;
    return new Chess(fen).move(submitted.trim())?.san === expected;
  } catch {
    return false;
  }
}
