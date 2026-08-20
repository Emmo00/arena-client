import "dotenv/config";
import { config } from "../lib/config";
import { dbCollections } from "../lib/db";
import { sweepStaleTournaments } from "../lib/settlement";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runOnce() {
  if (!config.contractAddress) return;

  const res = await sweepStaleTournaments();
  if (res.settled > 0 || res.refunded > 0 || res.reconciled > 0 || res.failed > 0) {
    console.log(
      `[settler] sweep settled=${res.settled} refunded=${res.refunded} reconciled=${res.reconciled} none=${res.none} failed=${res.failed}`
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