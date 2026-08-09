import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { LeaderboardError, renameUser } from "@/lib/leaderboard";
import { ApiError, badRequest, handleApiError, json } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest) {
  try {
    const address = await requireAuth(request);
    const body = await request.json();
    if (typeof body?.username !== "string" || !body.username.trim()) {
      throw badRequest("username required");
    }
    const res = await renameUser(address, body.username.trim());
    return json(res);
  } catch (e) {
    if (e instanceof LeaderboardError) {
      return handleApiError(new ApiError(e.status, e.code, e.message));
    }
    return handleApiError(e);
  }
}
