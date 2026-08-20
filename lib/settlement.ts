import { config } from "./config";
import { dbCollections, type TournamentDoc } from "./db";
import { getTournament, publicClient, submitRefundLocked, submitSettle } from "./chain";
import { arenaAbi } from "./abi";
import { pickWinner, sessionComplete } from "./scoring";
import { recordSettlement } from "./leaderboard";

const RETRY_MS = 60_000; // backoff before re-attempting a failed settle/refund
const LOCKED = 1;

async function onChainStillLocked(id: number): Promise<boolean> {
  try {
    const t = await getTournament(BigInt(id));
    return Number(t.status) === LOCKED;
  } catch (e) {
    console.error(`[settlement] read tournament ${id} failed:`, e);
    return false;
  }
}

export async function attemptSettle(t: TournamentDoc, winner: `0x${string}`) {
  const tournaments = await dbCollections().tournaments();
  const feeBps = await publicClient().readContract({
    address: config.contractAddress,
    abi: arenaAbi,
    functionName: "feeBps",
  });
  const stakeA = BigInt(t.stakeA);
  const stakeB = BigInt(t.stakeB ?? "0");
  const fee = ((stakeA + stakeB) * BigInt(feeBps)) / 10000n;

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
      console.error(`[settlement] recordSettlement(${t._id}) failed:`, e);
    }
    console.log(
      `[settlement] settled id=${t._id} winner=${winner} fee=${fee.toString()} tx=${receipt.transactionHash}`
    );
  } catch (e) {
    // Likely already settled/refunded by another actor, or transient. Re-check
    // on-chain next pass; if status flipped the indexer will reconcile.
    console.error(`[settlement] settle(${t._id}, ${winner}) failed:`, e);
  }
}

export async function attemptRefundLocked(t: TournamentDoc) {
  const tournaments = await dbCollections().tournaments();
  try {
    const receipt = await submitRefundLocked(BigInt(t._id));
    await tournaments.updateOne(
      { _id: t._id },
      { $set: { status: "Refunded", refundTx: receipt.transactionHash, updatedAt: Date.now() } }
    );
    console.log(`[settlement] refundLockedLobby id=${t._id} tx=${receipt.transactionHash}`);
  } catch (e) {
    console.error(`[settlement] refundLockedLobby(${t._id}) failed:`, e);
  }
}

/**
 * Decide whether a single locked tournament can be settled or refunded, and if
 * so kick it off. Used by both the settler worker (polling loop) and the
 * tournament status endpoint (settle-on-read).
 *
 * The claim is atomic (`findOneAndUpdate` on a null/stale attempt timestamp),
 * so concurrent callers — e.g. both players polling the status endpoint at once,
 * or the route racing the worker — can never double-submit gas; the loser's
 * claim matches nothing. Settlement/refund runs fire-and-forget, so the status
 * endpoint returns fast with `action: "settling"` while the tx confirms in the
 * background and the `Settled`/`LockedLobbyRefunded` event reconciles the DB.
 */
export async function maybeSettleTournament(
  id: number
): Promise<{ action: "settling" | "refunding" | "none" }> {
  if (!config.contractAddress) return { action: "none" };

  const tournaments = await dbCollections().tournaments();
  const t = await tournaments.findOne({ _id: id });
  if (!t) return { action: "none" };
  if (t.status !== "Locked" || t.settleTx) return { action: "none" };

  if (!(await onChainStillLocked(id))) return { action: "none" }; // indexer reconciles

  const now = Date.now();
  const matchTimeoutMs = config.matchTimeoutSeconds * 1000;
  const playerA = t.playerA as `0x${string}`;
  const playerB = (t.playerB ?? "") as `0x${string}`;
  const sessions = await dbCollections().sessions();
  const [sA, sB] = await Promise.all([
    sessions.findOne({ tournamentId: id, player: playerA }),
    playerB ? sessions.findOne({ tournamentId: id, player: playerB }) : null,
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
    const claimed = await tournaments.findOneAndUpdate(
      {
        _id: id,
        status: "Locked",
        settleTx: null,
        $or: [{ settleAttemptedAt: null }, { settleAttemptedAt: { $lt: now - RETRY_MS } }],
      },
      { $set: { settleAttemptedAt: now, updatedAt: now } }
    );
    if (!claimed) return { action: "none" };
    void attemptSettle(claimed, winner);
    return { action: "settling" };
  }

  if (refund) {
    const claimed = await tournaments.findOneAndUpdate(
      {
        _id: id,
        status: "Locked",
        settleTx: null,
        $or: [{ refundAttemptedAt: null }, { refundAttemptedAt: { $lt: now - RETRY_MS } }],
      },
      { $set: { refundAttemptedAt: now, updatedAt: now } }
    );
    if (!claimed) return { action: "none" };
    void attemptRefundLocked(claimed);
    return { action: "refunding" };
  }

  return { action: "none" };
}

export interface SweepResult {
  settling: number;
  refunding: number;
  none: number;
  errors: { id: number; error: string }[];
}

/**
 * Backstop sweep for stuck Locked tournaments: every tournament with two
 * participants that still has no settle tx is run through `maybeSettleTournament`,
 * which settles (both sessions complete), forfeits a no-show after the match
 * deadline, or refunds if neither side ever started. Safe to run concurrently
 * with the settler worker — the atomic claim prevents double-submits. One
 * failing tournament never aborts the rest; failures are returned for reporting.
 */
export async function sweepStaleTournaments(): Promise<SweepResult> {
  const tournaments = await dbCollections().tournaments();
  const locked = await tournaments.find({ status: "Locked", settleTx: null }).toArray();
  const result: SweepResult = { settling: 0, refunding: 0, none: 0, errors: [] };
  for (const t of locked) {
    try {
      const r = await maybeSettleTournament(t._id);
      if (r.action === "settling") result.settling++;
      else if (r.action === "refunding") result.refunding++;
      else result.none++;
    } catch (e) {
      console.error(`[settlement] sweep tournament ${t._id} failed:`, e);
      result.errors.push({ id: t._id, error: String(e) });
    }
  }
  return result;
}