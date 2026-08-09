import { NextRequest } from "next/server";
import { getUserByUsername } from "@/lib/leaderboard";
import { handleApiError, json, notFound } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ username: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const { username } = await params;
    const profile = await getUserByUsername(username);
    if (!profile) throw notFound("User not found");
    return json(profile);
  } catch (e) {
    return handleApiError(e);
  }
}
