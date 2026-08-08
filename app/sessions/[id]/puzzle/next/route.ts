import { NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { requireAuth } from "@/lib/auth";
import { dbCollections } from "@/lib/db";
import { ApiError, forbidden, gone, handleApiError, json, notFound } from "@/lib/http";
import { getPuzzleById, playerMovesOf } from "@/lib/puzzles";
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
    if (sessionExpired(s, now)) {
      throw gone("Session time window elapsed");
    }

    if (s.servedCount >= s.shuffled.length) {
      return json({ done: true, puzzleId: null });
    }

    const puzzleId = s.shuffled[s.servedCount];
    const puzzle = await getPuzzleById(puzzleId);
    if (!puzzle) {
      throw new ApiError(409, "PUZZLE_MISSING", "Cached puzzle no longer available");
    }

    await sessions.updateOne({ _id: s._id }, { $inc: { servedCount: 1 } });

    // NOTE: `moves` (the solution) is never included here.
    return json({
      puzzleId,
      fen: puzzle.fen,
      rating: puzzle.rating,
      themes: puzzle.themes,
      playerMoves: playerMovesOf(puzzle.moves),
    });
  } catch (e) {
    return handleApiError(e);
  }
}
