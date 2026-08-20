import { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { dbCollections } from "@/lib/db";
import { handleApiError, json, logOk, notFound } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const startedAt = Date.now();
  try {
    const { id: idRaw } = await params;
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id < 0) throw notFound("Lobby not found");

    const tournaments = await dbCollections().tournaments();
    const t = await tournaments.findOne({ _id: id });
    if (!t) throw notFound("Lobby not found");

    logOk("api", "GET /lobbies/[id] ok", startedAt, { id, status: t.status });
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
      serviced: t.serviced ?? true,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
