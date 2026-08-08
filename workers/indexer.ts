import "dotenv/config";
import { config } from "../lib/config";
import { dbCollections, type TournamentDoc } from "../lib/db";
import { allArenaEvents, getLogsChunked, publicClient } from "../lib/chain";
import { sampleSubset } from "../lib/puzzles";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type ArenaEventName =
  | "LobbyOpened"
  | "LobbyAccepted"
  | "Settled"
  | "LobbyRefunded"
  | "LockedLobbyRefunded";

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

async function processLog(log: ArenaLog) {
  const tournaments = await dbCollections().tournaments();
  const id = Number(log.args.id);
  const ts = await blockTimestamp(log.blockNumber!);
  const now = Date.now();

  switch (log.eventName) {
    case "LobbyOpened": {
      const existing = await tournaments.findOne({ _id: id });
      if (existing) return;
      // Assign the fixed puzzle subset from the *current* cache generation.
      const subset = await sampleSubset(config.puzzlePoolSize);
      const doc: TournamentDoc = {
        _id: id,
        status: "Open",
        playerA: log.args.playerA ?? "",
        playerB: null,
        stakeA: (log.args.stake ?? 0n).toString(),
        stakeB: null,
        openedAt: ts,
        lockedAt: null,
        generation: null,
        puzzleSubset: subset,
        winner: null,
        fee: null,
        settleTx: null,
        refundTx: null,
        settleAttemptedAt: null,
        refundAttemptedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await tournaments.insertOne(doc);
      console.log(`[indexer] LobbyOpened id=${id} playerA=${doc.playerA} subset=${subset.length}`);
      break;
    }
    case "LobbyAccepted": {
      const t = await tournaments.findOne({ _id: id });
      if (!t) return;
      await tournaments.updateOne(
        { _id: id },
        {
          $set: {
            status: "Locked",
            playerB: log.args.playerB ?? "",
            stakeB: t.stakeA, // equal by design (stakeAmount)
            lockedAt: ts,
            updatedAt: now,
          },
        }
      );
      console.log(`[indexer] LobbyAccepted id=${id} playerB=${log.args.playerB}`);
      break;
    }
    case "Settled": {
      await tournaments.updateOne(
        { _id: id },
        {
          $set: {
            status: "Settled",
            winner: log.args.winner ?? "",
            fee: (log.args.fee ?? 0n).toString(),
            settleTx: log.transactionHash,
            updatedAt: now,
          },
        }
      );
      console.log(`[indexer] Settled id=${id} winner=${log.args.winner} tx=${log.transactionHash}`);
      break;
    }
    case "LobbyRefunded": {
      await tournaments.updateOne(
        { _id: id },
        { $set: { status: "Refunded", refundTx: log.transactionHash, updatedAt: now } }
      );
      console.log(`[indexer] LobbyRefunded id=${id} tx=${log.transactionHash}`);
      break;
    }
    case "LockedLobbyRefunded": {
      await tournaments.updateOne(
        { _id: id },
        { $set: { status: "Refunded", refundTx: log.transactionHash, updatedAt: now } }
      );
      console.log(`[indexer] LockedLobbyRefunded id=${id} tx=${log.transactionHash}`);
      break;
    }
  }
}

export async function run() {
  const pc = publicClient();
  while (true) {
    try {
      const latest = await pc.getBlockNumber();
      const from = (await getLastBlock()) + 1n;
      if (from <= latest) {
        const logs = await getLogsChunked(from, latest, allArenaEvents);
        for (const log of logs) {
          await processLog(log as unknown as ArenaLog);
        }
        await setLastBlock(latest);
      }
    } catch (e) {
      console.error("[indexer] poll error:", e);
    }
    await sleep(config.indexerPollMs);
  }
}

if (process.argv[1]?.endsWith("indexer.ts")) {
  run().catch((e) => {
    console.error("[indexer] fatal:", e);
    process.exit(1);
  });
}
