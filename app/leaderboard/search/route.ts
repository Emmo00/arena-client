import { NextRequest } from "next/server";
import { searchUsers } from "@/lib/leaderboard";
import { handleApiError, json, logOk } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const q = new URL(request.url).searchParams.get("q") ?? "";
    const results = await searchUsers(q);
    logOk("api", "GET /leaderboard/search ok", startedAt, { q, results: results.length });
    return json({ results });
  } catch (e) {
    return handleApiError(e);
  }
}
