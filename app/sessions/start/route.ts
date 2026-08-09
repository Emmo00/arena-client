import { NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { requireAuth } from "@/lib/auth";
import { config } from "@/lib/config";
import { dbCollections } from "@/lib/db";
import { ApiError, badRequest, conflict, forbidden, handleApiError, json } from "@/lib/http";
import { sampleSubset } from "@/lib/puzzles";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const address = await requireAuth(request);
    const body = await request.json();
    const tournamentId = Number(body?.tournamentId);
    if (!Number.isInteger(tournamentId) || tournamentId < 0) {
      throw badRequest("tournamentId required");
    }

    const tournaments = await dbCollections().tournaments();
    const t = await tournaments.findOne({ _id: tournamentId });
    if (!t) {
      throw new ApiError(
        409,
        "NOT_INDEXED",
        "Tournament not indexed yet — poll GET /tournaments/:id until it appears"
      );
    }

    const isA = t.playerA === address;
    const isB = t.playerB === address;
    if (!isA && !isB) throw forbidden("Not a participant of this tournament");
    if (t.serviced === false) {
      throw new ApiError(
        409,
        "NO_LOBBY_CAPACITY",
        "Lobby opened beyond app capacity (MAX_OPEN_LOBBIES) — it will not be serviced; wait for lobbyTimeout and refundLobby(id)"
      );
    }
    if (isB && t.status !== "Locked") {
      throw conflict("Tournament must be Locked before playerB can start a session");
    }
    if (t.status === "Settled") throw conflict("Tournament already settled");
    if (t.status === "Refunded") throw conflict("Tournament already refunded");

    const sessions = await dbCollections().sessions();
    const existing = await sessions.findOne({ tournamentId, player: address });
    if (existing) throw conflict("Session already started for this player");

    // Assign the fixed subset if the indexer ran before the cache existed.
    let subset = t.puzzleSubset;
    if (!subset || subset.length === 0) {
      subset = await sampleSubset(config.puzzlePoolSize);
      if (subset.length === 0) {
        throw new ApiError(503, "NO_PUZZLES", "Puzzle cache not ready yet — retry shortly");
      }
      await tournaments.updateOne(
        { _id: tournamentId },
        { $set: { puzzleSubset: subset, updatedAt: Date.now() } }
      );
    }

    const shuffled = shuffle([...subset]);
    const now = Date.now();
    const deadline = now + config.sessionDurationSeconds * 1000;

    const inserted = await sessions.insertOne({
      _id: new ObjectId(),
      tournamentId,
      player: address,
      startedAt: now,
      deadline,
      shuffled,
      servedCount: 0,
      solvedCount: 0,
      ratingSum: 0,
      lastSubmittedAt: null,
      completedAt: null,
    });

    return json({
      sessionId: inserted.insertedId.toString(),
      tournamentId,
      startedAt: now,
      deadline,
    });
  } catch (e) {
    return handleApiError(e);
  }
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
