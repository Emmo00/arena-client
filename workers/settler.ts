import "dotenv/config";
import { config } from "../lib/config";
import { dbCollections } from "../lib/db";
import { sweepStaleTournaments } from "../lib/settlement";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runOnce() {
  if (!config.contractAddress) return;

  const res = await sweepStaleTournaments();
  if (res.settling > 0 || res.refunding > 0 || res.errors.length > 0) {
    console.log(
      `[settler] sweep settling=${res.settling} refunding=${res.refunding} none=${res.none} errors=${res.errors.length}`
    );
  }
}

export async function run() {
  await dbCollections();
  while (true) {
    try {
      await runOnce();
    } catch (e) {
      console.error("[settler] error:", e);
    }
    await sleep(config.settlerPollMs);
  }
}

if (process.argv[1]?.endsWith("settler.ts")) {
  run().catch((e) => {
    console.error("[settler] fatal:", e);
    process.exit(1);
  });
}