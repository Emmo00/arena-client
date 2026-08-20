import { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { handleApiError, json, logOk, unauthorized } from "@/lib/http";
import { logger } from "@/lib/logger";
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
 * /cache/refresh and /indexer/run. Settle/refund txs are awaited through
 * signing, confirmation, and DB update, so the response reflects completed
 * outcomes — may take tens of seconds when tournaments are resolving.
 */
export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (!config.cacheRefreshToken || token !== config.cacheRefreshToken) {
      throw unauthorized("Invalid or missing sweep token");
    }
    logger.info("settle-sweep", "POST /settle/sweep start");

    const res = await sweepStaleTournaments();
    logOk("settle-sweep", "POST /settle/sweep done", startedAt, {
      settled: res.settled,
      refunded: res.refunded,
      reconciled: res.reconciled,
      none: res.none,
      failed: res.failed,
      errors: res.errors.length,
    });
    return json({
      ok: true,
      settled: res.settled,
      refunded: res.refunded,
      reconciled: res.reconciled,
      none: res.none,
      failed: res.failed,
      errors: res.errors,
      details: res.details,
    });
  } catch (e) {
    return handleApiError(e);
  }
}