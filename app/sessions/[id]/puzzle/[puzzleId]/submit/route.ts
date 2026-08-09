import { NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { requireAuth } from "@/lib/auth";
import { dbCollections } from "@/lib/db";
import {
  ApiError,
  badRequest,
  conflict,
  forbidden,
  gone,
  handleApiError,
  json,
  notFound,
} from "@/lib/http";
import { getPuzzleById, isCorrectMove } from "@/lib/puzzles";
import { sessionExpired } from "@/lib/scoring";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; puzzleId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const address = await requireAuth(request);
    const { id, puzzleId } = await params;

    let objectId: ObjectId;
    try {
      objectId = new ObjectId(id);
    } catch {
      throw notFound("Session not found");
    }

    const body = await request.json();
    if (typeof body?.move !== "string" || !body.move.trim()) {
      throw badRequest("move required");
    }
    const move: string = body.move.trim();

    const sessions = await dbCollections().sessions();
    const s = await sessions.findOne({ _id: objectId });
    if (!s) throw notFound("Session not found");
    if (s.player !== address) throw forbidden("Not your session");

    const now = Date.now();
    // Deadline is enforced server-side regardless of client claims.
    if (sessionExpired(s, now)) {
      throw gone("Session time window elapsed");
    }

    if (s.servedCount < 1) {
      throw conflict("No puzzle served yet — fetch one first");
    }
    const expected = s.shuffled[s.servedCount - 1];
    if (expected !== puzzleId) {
      throw conflict("Submit the current puzzle before moving on");
    }

    const submissions = await dbCollections().submissions();
    const already = await submissions.findOne({ sessionId: s._id, puzzleId });
    if (already) {
      throw conflict("Puzzle already submitted");
    }

    const puzzle = await getPuzzleById(puzzleId);
    if (!puzzle) {
      throw new ApiError(409, "PUZZLE_MISSING", "Cached puzzle no longer available");
    }

    const correct = isCorrectMove(move, puzzle.moves, puzzle.fen);
    const ratingAwarded = correct ? puzzle.rating : 0;
    const elapsedMs = now - s.startedAt;

    await sessions.updateOne(
      { _id: s._id },
      {
        $inc: { solvedCount: correct ? 1 : 0, ratingSum: ratingAwarded },
        $set: { lastSubmittedAt: now },
      }
    );
    await submissions.insertOne({
      _id: new ObjectId(),
      sessionId: s._id,
      puzzleId,
      correct,
      elapsedMs,
      submittedAt: now,
    });

    return json({ correct, ratingAwarded });
  } catch (e) {
    return handleApiError(e);
  }
}
