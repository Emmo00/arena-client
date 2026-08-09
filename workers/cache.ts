import "dotenv/config";
import { config } from "../lib/config";
import { dbCollections } from "../lib/db";
import { maybeRefreshCache } from "../lib/puzzles";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function run() {
  await dbCollections();
  while (true) {
    try {
      const res = await maybeRefreshCache();
      if (res.refreshed) {
        console.log(
          `[cache] refreshed mode=${res.mode} pool=${res.pool} inserted=${res.inserted}`
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
