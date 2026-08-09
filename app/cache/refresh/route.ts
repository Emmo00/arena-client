import { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { handleApiError, json, unauthorized } from "@/lib/http";
import { maybeRefreshCache } from "@/lib/puzzles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /cache/refresh
 *
 * Trigger a puzzle-pool refresh on demand. Protected by a bearer token so a
 * GitHub Actions cron (or any scheduler) can call it instead of running the
 * cache worker. Returns the refreshed state and the current pool size.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (!config.cacheRefreshToken || token !== config.cacheRefreshToken) {
      throw unauthorized("Invalid or missing cache refresh token");
    }

    const res = await maybeRefreshCache();
    return json({
      ok: true,
      refreshed: res.refreshed,
      mode: res.mode,
      inserted: res.inserted,
      pool: res.pool,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
