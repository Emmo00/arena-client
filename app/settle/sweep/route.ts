import { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { handleApiError, json, unauthorized } from "@/lib/http";
import { sweepStaleTournaments } from "@/lib/settlement";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /settle/sweep
 *
 * Backstop for stuck Locked tournaments (both players accepted but nothing
 * settled): runs the same sweep as the settler worker, on demand. Protected by
 * a bearer token so a GitHub Actions cron (or any scheduler) can trigger it
 * without running the worker container. Reuses the same token as
 * /cache/refresh and /indexer/run.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (!config.cacheRefreshToken || token !== config.cacheRefreshToken) {
      throw unauthorized("Invalid or missing sweep token");
    }

    const res = await sweepStaleTournaments();
    return json({
      ok: true,
      settling: res.settling,
      refunding: res.refunding,
      none: res.none,
      errors: res.errors,
    });
  } catch (e) {
    return handleApiError(e);
  }
}