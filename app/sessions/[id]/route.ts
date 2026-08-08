import { NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { requireAuth } from "@/lib/auth";
import { dbCollections } from "@/lib/db";
import { forbidden, handleApiError, json, notFound } from "@/lib/http";
import { sessionExpired } from "@/lib/scoring";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const address = await requireAuth(request);
    const { id } = await params;
    let objectId: ObjectId;
    try {
      objectId = new ObjectId(id);
    } catch {
      throw notFound("Session not found");
    }

    const sessions = await dbCollections().sessions();
    const s = await sessions.findOne({ _id: objectId });
    if (!s) throw notFound("Session not found");
    if (s.player !== address) throw forbidden("Not your session");

    const now = Date.now();
    return json({
      sessionId: s._id.toString(),
      tournamentId: s.tournamentId,
      player: s.player,
      startedAt: s.startedAt,
      deadline: s.deadline,
      puzzlesTotal: s.shuffled.length,
      puzzlesServed: s.servedCount,
      puzzlesSolved: s.solvedCount,
      ratingSum: s.ratingSum,
      timeRemainingMs: Math.max(0, s.deadline - now),
      status: sessionExpired(s, now) ? "expired" : "running",
    });
  } catch (e) {
    return handleApiError(e);
  }
}
