import { config } from "./config";
import { dbCollections, type TournamentDoc } from "./db";
import { sampleSubset } from "./puzzles";

export type ArenaEventName =
  | "LobbyOpened"
  | "LobbyAccepted"
  | "Settled"
  | "LobbyRefunded"
  | "LockedLobbyRefunded";

export type ArenaEventInput = {
  eventName: ArenaEventName;
  id: bigint;
  playerA?: string;
  playerB?: string;
  winner?: string;
  stake?: bigint;
  fee?: bigint;
  transactionHash: string;
  /** Block timestamp in epoch seconds (from the emitting block). */
  timestamp: number;
};

/**
 * Apply a single Arena on-chain event to the tournament collection.
 *
 * Idempotent: replaying the same event (webhook retries, backfill overlap)
 * never corrupts state. This is the single source of truth used by both the
 * Alchemy GraphQL webhook receiver and the backfill indexer.
 */
export async function processArenaEvent(ev: ArenaEventInput) {
  const tournaments = await dbCollections().tournaments();
  const id = Number(ev.id);
  const now = Date.now();

  switch (ev.eventName) {
    case "LobbyOpened": {
      const existing = await tournaments.findOne({ _id: id });
      if (existing) return;
      // App-side cap on simultaneously serviced open lobbies. Lobbies opened
      // beyond MAX_OPEN_LOBBIES are still indexed (so the agent can see the
      // `serviced:false` flag) but never get a puzzle subset or a session; the
      // stake is returned by refundLobby/refundLockedLobby on-chain.
      const openServiced = await tournaments.countDocuments({
        status: "Open",
        serviced: { $ne: false },
      });
      const serviced = openServiced < config.maxOpenLobbies;
      const doc: TournamentDoc = {
        _id: id,
        status: "Open",
        playerA: ev.playerA ?? "",
        playerB: null,
        stakeA: (ev.stake ?? 0n).toString(),
        stakeB: null,
        openedAt: ev.timestamp,
        lockedAt: null,
        serviced,
        generation: null,
        puzzleSubset: serviced ? await sampleSubset(config.puzzlePoolSize) : [],
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
      console.log(
        `[events] LobbyOpened id=${id} playerA=${doc.playerA} serviced=${serviced} subset=${doc.puzzleSubset.length}`
      );
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
            playerB: ev.playerB ?? "",
            stakeB: t.stakeA, // equal by design (stakeAmount)
            lockedAt: ev.timestamp,
            updatedAt: now,
          },
        }
      );
      console.log(`[events] LobbyAccepted id=${id} playerB=${ev.playerB}`);
      break;
    }
    case "Settled": {
      await tournaments.updateOne(
        { _id: id },
        {
          $set: {
            status: "Settled",
            winner: ev.winner ?? "",
            fee: (ev.fee ?? 0n).toString(),
            settleTx: ev.transactionHash,
            updatedAt: now,
          },
        }
      );
      console.log(`[events] Settled id=${id} winner=${ev.winner} tx=${ev.transactionHash}`);
      break;
    }
    case "LobbyRefunded": {
      await tournaments.updateOne(
        { _id: id },
        { $set: { status: "Refunded", refundTx: ev.transactionHash, updatedAt: now } }
      );
      console.log(`[events] LobbyRefunded id=${id} tx=${ev.transactionHash}`);
      break;
    }
    case "LockedLobbyRefunded": {
      await tournaments.updateOne(
        { _id: id },
        { $set: { status: "Refunded", refundTx: ev.transactionHash, updatedAt: now } }
      );
      console.log(`[events] LockedLobbyRefunded id=${id} tx=${ev.transactionHash}`);
      break;
    }
  }
}
