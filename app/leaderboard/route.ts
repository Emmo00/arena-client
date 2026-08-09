import { NextRequest } from "next/server";
import { getLeaderboardPage } from "@/lib/leaderboard";
import { badRequest, handleApiError, json } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const cursor = searchParams.get("cursor") ?? undefined;
    const limitRaw = searchParams.get("limit");
    let limit: number | undefined;
    if (limitRaw !== null) {
      limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit <= 0) throw badRequest("limit must be a positive integer");
    }
    const page = await getLeaderboardPage(cursor, limit);
    if (page === null) throw badRequest("invalid cursor");
    return json(page);
  } catch (e) {
    return handleApiError(e);
  }
}
