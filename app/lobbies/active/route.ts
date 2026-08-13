import { config } from "@/lib/config";
import { listActiveLobbies } from "@/lib/lobbies";
import { handleApiError, json } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Live "matched, not ended" lobbies: status Locked, serviced. Public read. */
export async function GET() {
  try {
    const lobbies = await listActiveLobbies(50);
    return json({
      lobbies: lobbies.map((t) => ({
        id: t.id,
        playerA: t.playerA,
        playerB: t.playerB,
        stakeA: t.stakeA,
        stakeB: t.stakeB,
        lockedAt: t.lockedAt,
        expiresAt: t.expiresAt,
        serviced: t.serviced,
      })),
      count: lobbies.length,
      capacity: config.maxOpenLobbies,
    });
  } catch (e) {
    return handleApiError(e);
  }
}