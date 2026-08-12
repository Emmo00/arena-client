import "dotenv/config";
import { config } from "../lib/config";
import { dbCollections } from "../lib/db";
import { maybeSettleTournament } from "../lib/settlement";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runOnce() {
  if (!config.contractAddress) return;

  const tournaments = await dbCollections().tournaments();
  const locked = await tournaments.find({ status: "Locked", settleTx: null }).toArray();

  for (const t of locked) {
    await maybeSettleTournament(t._id);
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