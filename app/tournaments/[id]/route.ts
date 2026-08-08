import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { config } from "@/lib/config";
import { dbCollections } from "@/lib/db";
import { forbidden, handleApiError, json, notFound } from "@/lib/http";

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

    const sessions = await dbCollections().sessions();
    const sessionDocs = await sessions.find({ tournamentId: id }).toArray();

    return json({
      id: t._id,
      status: t.status,
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
      sessions: sessionDocs.map((s) => ({
        sessionId: s._id.toString(),
        player: s.player,
        startedAt: s.startedAt,
        deadline: s.deadline,
        puzzlesSolved: s.solvedCount,
        ratingSum: s.ratingSum,
      })),
    });
  } catch (e) {
    return handleApiError(e);
  }
}
