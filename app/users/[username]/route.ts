import { NextRequest } from "next/server";
import { getUserByUsername } from "@/lib/leaderboard";
import { handleApiError, json, logOk, notFound } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ username: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const startedAt = Date.now();
  try {
    const { username } = await params;
    const profile = await getUserByUsername(username);
    if (!profile) throw notFound("User not found");
    logOk("api", "GET /users/[username] ok", startedAt, { username });
    return json(profile);
  } catch (e) {
    return handleApiError(e);
  }
}
