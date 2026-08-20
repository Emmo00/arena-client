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

export type SettleResult =
  | { ok: true; action: "settled"; tx: string; fee: string }
  | { ok: false; action: "failed"; error: string };

export async function attemptSettle(
  t: TournamentDoc,
  winner: `0x${string}`
): Promise<SettleResult> {
  const tournaments = await dbCollections().tournaments();
  try {
    const feeBps = await publicClient().readContract({
      address: config.contractAddress,
      abi: arenaAbi,
      functionName: "feeBps",
    });
    const stakeA = BigInt(t.stakeA);
    const stakeB = BigInt(t.stakeB ?? "0");
    const fee = ((stakeA + stakeB) * BigInt(feeBps)) / 10000n;

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
    return { ok: true, action: "settled", tx: receipt.transactionHash, fee: fee.toString() };
  } catch (e) {
    // Likely already settled/refunded by another actor, or transient. Re-check
    // on-chain next pass; if status flipped the indexer will reconcile.
    console.error(`[settlement] settle(${t._id}, ${winner}) failed:`, e);
    return { ok: false, action: "failed", error: String(e) };
  }
}

export type RefundResult =
  | { ok: true; action: "refunded"; tx: string }
  | { ok: false; action: "failed"; error: string };

export async function attemptRefundLocked(t: TournamentDoc): Promise<RefundResult> {
  const tournaments = await dbCollections().tournaments();
  try {
    const receipt = await submitRefundLocked(BigInt(t._id));
    await tournaments.updateOne(
      { _id: t._id },
      { $set: { status: "Refunded", refundTx: receipt.transactionHash, updatedAt: Date.now() } }
    );
    console.log(`[settlement] refundLockedLobby id=${t._id} tx=${receipt.transactionHash}`);
    return { ok: true, action: "refunded", tx: receipt.transactionHash };
  } catch (e) {
    console.error(`[settlement] refundLockedLobby(${t._id}) failed:`, e);
    return { ok: false, action: "failed", error: String(e) };
  }
}

/**
 * Decide whether a single locked tournament can be settled or refunded, and if
 * so kick it off. Used by the settler worker (polling loop), the tournament
 * status endpoint (settle-on-read), and the sweep endpoint.
 *
 * The claim is atomic (`findOneAndUpdate` on a null/stale attempt timestamp),
 * so concurrent callers — e.g. both players polling the status endpoint at once,
 * or the route racing the worker — can never double-submit gas; the loser's
 * claim matches nothing.
 *
 * By default (`awaitTx: false`) the settlement/refund runs fire-and-forget, so
 * the status endpoint returns fast with `action: "settling"` while the tx
 * confirms in the background and the `Settled`/`LockedLobbyRefunded` event
 * reconciles the DB. With `awaitTx: true` the tx is awaited through signing,
 * confirmation, and DB update before returning, so callers (the sweep) can
 * report completed outcomes.
 */
export async function maybeSettleTournament(
  id: number,
  opts: { awaitTx?: boolean } = {}
): Promise<{
  action: "settling" | "refunding" | "none" | "settled" | "refunded" | "failed" | "reconciled";
  tx?: string;
  fee?: string;
  error?: string;
}> {
  if (!config.contractAddress) return { action: "none" };

  const tournaments = await dbCollections().tournaments();
  const t = await tournaments.findOne({ _id: id });
  if (!t) return { action: "none" };
  if (t.status !== "Locked") return { action: "none" };

  // Anomaly reconciliation: DB says "Locked" but a confirmed settle/refund tx is
  // already on the doc (e.g. a late/replayed event regressed the status after a
  // settle/refund completed). Re-derive status from on-chain instead of bailing
  // or double-acting. A confirmed tx hash means on-chain already moved on, so an
  // on-chain read failure still reconciles rather than leaving the doc stuck.
  if (t.settleTx || t.refundTx) {
    const target = t.settleTx ? "Settled" : "Refunded";
    if (!(await onChainStillLocked(id))) {
      await tournaments.updateOne(
        { _id: id, status: "Locked" },
        { $set: { status: target, updatedAt: Date.now() } }
      );
      console.log(
        `[settlement] reconciled id=${id}: DB Locked but ${t.settleTx ? "settle" : "refund"}Tx present -> ${target}`
      );
      return { action: "reconciled" };
    }
    console.warn(
      `[settlement] id=${id} ${t.settleTx ? "settle" : "refund"}Tx present but on-chain still Locked; leaving for review`
    );
    return { action: "none" };
  }

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
      // Perfect tie (pickWinner returns null): no winner, refund both via the
      // contract once the match window elapsed.
      if (!winner && now >= matchDeadline) refund = true;
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
    if (opts.awaitTx) {
      const res = await attemptSettle(claimed, winner);
      return {
        action: res.action,
        tx: res.ok ? res.tx : undefined,
        fee: res.ok ? res.fee : undefined,
        error: res.ok ? undefined : res.error,
      };
    }
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
    if (opts.awaitTx) {
      const res = await attemptRefundLocked(claimed);
      return {
        action: res.action,
        tx: res.ok ? res.tx : undefined,
        error: res.ok ? undefined : res.error,
      };
    }
    void attemptRefundLocked(claimed);
    return { action: "refunding" };
  }

  return { action: "none" };
}

export interface SweepResult {
  settled: number;
  refunded: number;
  reconciled: number;
  none: number;
  failed: number;
  errors: { id: number; error: string }[];
  details: {
    id: number;
    action: string;
    tx?: string;
    fee?: string;
    error?: string;
  }[];
}

/**
 * Backstop sweep for stuck Locked tournaments: every tournament that is still
 * Locked is run through `maybeSettleTournament`, which settles (both sessions
 * complete), forfeits a no-show after the match deadline, refunds if neither
 * side ever started or the match is a perfect tie, and reconciles docs that
 * carry a confirmed settle/refund tx but a stale "Locked" status. Settle/refund
 * txs are awaited through confirmation and DB update, so the returned result
 * reflects completed outcomes. Safe to run concurrently with the settler worker
 * — the atomic claim prevents double-submits. One failing tournament never
 * aborts the rest; failures are returned for reporting.
 */
export async function sweepStaleTournaments(): Promise<SweepResult> {
  const started = Date.now();
  const tournaments = await dbCollections().tournaments();
  const locked = await tournaments.find({ status: "Locked" }).toArray();
  console.log(
    `[settlement] sweep start: ${locked.length} locked tournament(s) awaiting resolution`
  );
  const result: SweepResult = {
    settled: 0,
    refunded: 0,
    reconciled: 0,
    none: 0,
    failed: 0,
    errors: [],
    details: [],
  };
  for (const t of locked) {
    try {
      const r = await maybeSettleTournament(t._id, { awaitTx: true });
      const detail = {
        id: t._id,
        action: r.action,
        tx: r.tx,
        fee: r.fee,
        error: r.error,
      };
      result.details.push(detail);
      if (r.action === "settled") result.settled++;
      else if (r.action === "refunded") result.refunded++;
      else if (r.action === "reconciled") result.reconciled++;
      else if (r.action === "failed") {
        result.failed++;
        result.errors.push({ id: t._id, error: r.error ?? "unknown error" });
      } else result.none++;
      console.log(
        `[settlement] sweep tournament ${t._id}: ${r.action}` +
          (r.tx ? ` tx=${r.tx}` : "") +
          (r.error ? ` error=${r.error}` : "")
      );
    } catch (e) {
      console.error(`[settlement] sweep tournament ${t._id} failed:`, e);
      result.failed++;
      result.errors.push({ id: t._id, error: String(e) });
    }
  }
  console.log(
    `[settlement] sweep done in ${Date.now() - started}ms: ` +
      `settled=${result.settled} refunded=${result.refunded} reconciled=${result.reconciled} none=${result.none} failed=${result.failed}`
  );
  return result;
}