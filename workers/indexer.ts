import "dotenv/config";
import { config } from "../lib/config";
import { dbCollections } from "../lib/db";
import { allArenaEvents, getLogsChunked, publicClient } from "../lib/chain";
import { processArenaEvent, type ArenaEventName } from "../lib/events";

type ArenaLog = { blockNumber: bigint; transactionHash: `0x${string}` } & {
  eventName: ArenaEventName;
  args: {
    id?: bigint;
    playerA?: string;
    playerB?: string;
    winner?: string;
    stake?: bigint;
    fee?: bigint;
  };
};

async function getLastBlock(): Promise<bigint> {
  const meta = await dbCollections().meta();
  const doc = await meta.findOne({ _id: "indexer_last_block" });
  if (doc) return BigInt(doc.value);
  if (config.indexerStartBlock !== null) return config.indexerStartBlock - 1n;
  return publicClient().getBlockNumber();
}

async function setLastBlock(block: bigint) {
  const meta = await dbCollections().meta();
  await meta.updateOne(
    { _id: "indexer_last_block" },
    { $set: { value: block.toString() } },
    { upsert: true }
  );
}

const tsCache = new Map<bigint, number>();
async function blockTimestamp(n: bigint): Promise<number> {
  if (!tsCache.has(n)) {
    const block = await publicClient().getBlock({ blockNumber: n });
    tsCache.set(n, Number(block.timestamp));
  }
  return tsCache.get(n)!;
}

/**
 * One-shot backfill of all Arena events between the last indexed block and the
 * chain tip. Alchemy's GraphQL webhook is the primary (live) event source; this
 * script only catches up on history (deploy -> webhook creation) or recovers
 * after downtime. Run it periodically or on demand: `pnpm worker:indexer`.
 */
export async function run() {
  const pc = publicClient();
  const latest = await pc.getBlockNumber();
  const from = (await getLastBlock()) + 1n;
  if (from > latest) {
    console.log(`[indexer] up to date (last=${from - 1n} latest=${latest})`);
    return;
  }
  const logs = await getLogsChunked(from, latest, allArenaEvents);
  for (const log of logs) {
    const l = log as unknown as ArenaLog;
    await processArenaEvent({
      eventName: l.eventName,
      id: l.args.id ?? 0n,
      playerA: l.args.playerA,
      playerB: l.args.playerB,
      winner: l.args.winner,
      stake: l.args.stake,
      fee: l.args.fee,
      transactionHash: l.transactionHash,
      timestamp: await blockTimestamp(l.blockNumber),
    });
  }
  await setLastBlock(latest);
  console.log(`[indexer] backfilled ${logs.length} events (${from}..${latest})`);
}

if (process.argv[1]?.endsWith("indexer.ts")) {
  run()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("[indexer] fatal:", e);
      process.exit(1);
    });
}
