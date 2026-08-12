import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { config } from "@/lib/config";
import { dbCollections } from "@/lib/db";
import { forbidden, handleApiError, json, notFound } from "@/lib/http";
import { maybeSettleTournament } from "@/lib/settlement";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const address = await requireAuth(request);
    const { id: idRaw } = await params;
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id < 0) throw notFound("Tournament not found");

    const tournaments = await dbCollections().tournaments();
    const t = await tournaments.findOne({ _id: id });
    if (!t) throw notFound("Tournament not found");

    if (t.playerA !== address && t.playerB !== address) {
      throw forbidden("Not a participant of this tournament");
    }

    // Settle-on-read: if this locked tournament is ready, fire settlement (or
    // refund) and report a "Settling" status while the tx confirms. The claim
    // is atomic so concurrent readers / the worker can't double-submit.
    const resolution = await maybeSettleTournament(id);
    const status = resolution.action === "settling" ? "Settling" : t.status;

    const sessions = await dbCollections().sessions();
    const sessionDocs = await sessions.find({ tournamentId: id }).toArray();

    // Until the tournament is Settled, only expose the requesting player's own
    // session detail; the opponent's puzzlesSolved/ratingSum stay hidden so you
    // cannot scout their progress mid-match. Once Settled, both are shown.
    const settled = t.status === "Settled";
    const sessionsPublic = sessionDocs.map((s) => ({
      sessionId: s._id.toString(),
      player: s.player,
      startedAt: s.startedAt,
      deadline: s.deadline,
      ...(settled || s.player === address
        ? { puzzlesSolved: s.solvedCount, ratingSum: s.ratingSum }
        : {}),
    }));

    return json({
      id: t._id,
      status,
      playerA: t.playerA,
      playerB: t.playerB,
      stakeA: t.stakeA,
      stakeB: t.stakeB,
      openedAt: t.openedAt,
      lockedAt: t.lockedAt,
      expiresAt: t.openedAt + config.lobbyTimeoutSeconds,
      winner: t.winner,
      fee: t.fee,
      settleTx: t.settleTx,
      serviced: t.serviced ?? true,
      sessions: sessionsPublic,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
