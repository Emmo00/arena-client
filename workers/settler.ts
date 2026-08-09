import "dotenv/config";
import { config } from "../lib/config";
import { dbCollections, type TournamentDoc } from "../lib/db";
import { getTournament, publicClient, submitRefundLocked, submitSettle } from "../lib/chain";
import { arenaAbi } from "../lib/abi";
import { pickWinner, sessionComplete } from "../lib/scoring";
import { recordSettlement } from "../lib/leaderboard";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRY_MS = 60_000; // backoff before re-attempting a failed settle/refund

const LOCKED = 1;

async function onChainStillLocked(id: number): Promise<boolean> {
  try {
    const t = await getTournament(BigInt(id));
    return Number(t.status) === LOCKED;
  } catch (e) {
    console.error(`[settler] read tournament ${id} failed:`, e);
    return false;
  }
}

async function attemptSettle(t: TournamentDoc, winner: `0x${string}`) {
  const tournaments = await dbCollections().tournaments();
  const feeBps = await publicClient().readContract({
    address: config.contractAddress,
    abi: arenaAbi,
    functionName: "feeBps",
  });
  const stakeA = BigInt(t.stakeA);
  const stakeB = BigInt(t.stakeB ?? "0");
  const fee = ((stakeA + stakeB) * BigInt(feeBps)) / 10000n;

  await tournaments.updateOne(
    { _id: t._id },
    { $set: { settleAttemptedAt: Date.now(), updatedAt: Date.now() } }
  );

  try {
    const receipt = await submitSettle(BigInt(t._id), winner);
    await tournaments.updateOne(
      { _id: t._id },
      {
        $set: {
          status: "Settled",
          winner,
          fee: fee.toString(),
          settleTx: receipt.transactionHash,
          updatedAt: Date.now(),
        },
      }
    );
    // Best-effort: if this fails, the Settled-event path (webhook/indexer)
    // applies the rows via the idempotent guards.
    try {
      await recordSettlement(t._id, winner, Number(fee));
    } catch (e) {
      console.error(`[settler] recordSettlement(${t._id}) failed:`, e);
    }
    console.log(
      `[settler] settled id=${t._id} winner=${winner} fee=${fee.toString()} tx=${receipt.transactionHash}`
    );
  } catch (e) {
    // Likely already settled/refunded by another actor, or transient. Re-check
    // on-chain next pass; if status flipped the indexer will reconcile.
    console.error(`[settler] settle(${t._id}, ${winner}) failed:`, e);
  }
}

async function attemptRefundLocked(t: TournamentDoc) {
  const tournaments = await dbCollections().tournaments();
  await tournaments.updateOne(
    { _id: t._id },
    { $set: { refundAttemptedAt: Date.now(), updatedAt: Date.now() } }
  );
  try {
    const receipt = await submitRefundLocked(BigInt(t._id));
    await tournaments.updateOne(
      { _id: t._id },
      { $set: { status: "Refunded", refundTx: receipt.transactionHash, updatedAt: Date.now() } }
    );
    console.log(`[settler] refundLockedLobby id=${t._id} tx=${receipt.transactionHash}`);
  } catch (e) {
    console.error(`[settler] refundLockedLobby(${t._id}) failed:`, e);
  }
}

async function runOnce() {
  if (!config.contractAddress) return;

  const tournaments = await dbCollections().tournaments();
  const sessions = await dbCollections().sessions();
  const locked = await tournaments
    .find({ status: "Locked", settleTx: null })
    .toArray();
  const now = Date.now();
  const matchTimeoutMs = config.matchTimeoutSeconds * 1000;

  for (const t of locked) {
    if (!(await onChainStillLocked(t._id))) continue; // indexer reconciles

    const playerA = t.playerA as `0x${string}`;
    const playerB = (t.playerB ?? "") as `0x${string}`;
    const [sA, sB] = await Promise.all([
      sessions.findOne({ tournamentId: t._id, player: playerA }),
      playerB ? sessions.findOne({ tournamentId: t._id, player: playerB }) : null,
    ]);

    const matchDeadline = ((t.lockedAt ?? 0) * 1000) + matchTimeoutMs;
    let winner: `0x${string}` | null = null;
    let refund = false;

    if (sA && sB) {
      if (sessionComplete(sA, now) && sessionComplete(sB, now)) {
        winner = pickWinner(playerA, playerB, sA, sB);
      }
    } else if (sA && !sB) {
      if (now >= matchDeadline) winner = playerA; // no-show B => forfeit
    } else if (!sA && sB) {
      if (now >= matchDeadline) winner = playerB; // no-show A => forfeit
    } else {
      // neither side ever started: no winner, refund both via the contract.
      if (now >= matchDeadline) refund = true;
    }

    if (winner) {
      const lastAttempt = t.settleAttemptedAt ?? 0;
      if (now - lastAttempt >= RETRY_MS) await attemptSettle(t, winner);
    } else if (refund) {
      const lastAttempt = t.refundAttemptedAt ?? 0;
      if (now - lastAttempt >= RETRY_MS) await attemptRefundLocked(t);
    }
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
