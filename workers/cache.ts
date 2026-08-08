import "dotenv/config";
import { config } from "../lib/config";
import { dbCollections } from "../lib/db";
import { currentPuzzleCount, refreshCache } from "../lib/puzzles";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REFRESH_MS = config.puzzleCacheRefreshHours * 3600 * 1000;

async function getLastRefresh(): Promise<number> {
  const meta = await dbCollections().meta();
  const doc = await meta.findOne({ _id: "cache_last_refresh" });
  return doc ? Number(doc.value) : 0;
}

async function setLastRefresh(ts: number) {
  const meta = await dbCollections().meta();
  await meta.updateOne(
    { _id: "cache_last_refresh" },
    { $set: { value: String(ts) } },
    { upsert: true }
  );
}

export async function run() {
  await dbCollections();
  while (true) {
    try {
      const count = await currentPuzzleCount();
      const last = await getLastRefresh();
      const due = Date.now() - last >= REFRESH_MS;
      const low = count < config.puzzlePoolSize;
      if (due || low) {
        const { mode, inserted } = await refreshCache();
        await setLastRefresh(Date.now());
        console.log(
          `[cache] refreshed mode=${mode} pool=${count} -> ${inserted} (${due ? "scheduled" : "low-pool"})`
        );
      }
    } catch (e) {
      console.error("[cache] error:", e);
    }
    await sleep(config.cachePollMs);
  }
}

if (process.argv[1]?.endsWith("cache.ts")) {
  run().catch((e) => {
    console.error("[cache] fatal:", e);
    process.exit(1);
  });
}
