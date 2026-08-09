import { NextRequest } from "next/server";
import { searchUsers } from "@/lib/leaderboard";
import { handleApiError, json } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const q = new URL(request.url).searchParams.get("q") ?? "";
    const results = await searchUsers(q);
    return json({ results });
  } catch (e) {
    return handleApiError(e);
  }
}
