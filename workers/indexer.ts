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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry `fn` with exponential backoff (base * 2^attempt, capped + jittered).
 * Throws the last error after `indexerBackoffMaxAttempts`. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= config.indexerBackoffMaxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt === config.indexerBackoffMaxAttempts) break;
      const delay = Math.min(
        config.indexerBackoffBaseMs * 2 ** (attempt - 1),
        config.indexerBackoffMaxMs
      );
      const jittered = delay / 2 + Math.random() * (delay / 2);
      console.warn(
        `[indexer] retry ${attempt}/${config.indexerBackoffMaxAttempts} in ${Math.round(jittered)}ms: ${e}`
      );
      await sleep(jittered);
    }
  }
  throw lastError;
}

const tsCache = new Map<bigint, number>();
async function blockTimestamp(n: bigint): Promise<number> {
  if (!tsCache.has(n)) {
    const block = await withRetry(() => publicClient().getBlock({ blockNumber: n }));
    tsCache.set(n, Number(block.timestamp));
  }
  return tsCache.get(n)!;
}

/**
 * One-shot backfill of all Arena events between the last indexed block and the
 * chain tip. Alchemy's GraphQL webhook is the primary (live) event source; this
 * script only catches up on history (deploy -> webhook creation) or recovers
 * after downtime. Run it periodically or on demand: `pnpm worker:indexer`.
 *
 * Scans in fixed `indexerBlockRange`-block windows and persists the last indexed
 * block after each window, so an interrupted or failed run resumes from the
 * database instead of starting over. Transient RPC errors are retried with
 * exponential backoff.
 */
export async function run(): Promise<{ logs: number; from: bigint; latest: bigint }> {
  const pc = publicClient();
  const latest = await withRetry(() => pc.getBlockNumber());
  const firstFrom = (await getLastBlock()) + 1n;

  let total = 0;
  let from = firstFrom;
  while (from <= latest) {
    const windowEnd = from + BigInt(config.indexerBlockRange) - 1n;
    const to = windowEnd > latest ? latest : windowEnd;
    const logs = await withRetry(() => getLogsChunked(from, to, allArenaEvents));
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
    await setLastBlock(to);
    total += logs.length;
    console.log(`[indexer] window ${from}..${to} -> ${logs.length} events (${total} total)`);
    from = to + 1n;
  }

  console.log(`[indexer] up to date (last=${from - 1n} latest=${latest})`);
  return { logs: total, from: firstFrom, latest };
}

if (process.argv[1]?.endsWith("indexer.ts")) {
  run()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("[indexer] fatal:", e);
      process.exit(1);
    });
}
