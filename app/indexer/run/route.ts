import { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { handleApiError, json, logOk, unauthorized } from "@/lib/http";
import { logger } from "@/lib/logger";
import { run as runIndexer } from "@/workers/indexer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /indexer/run
 *
 * Run the indexer backfill on demand. Protected by a bearer token so a GitHub
 * Actions cron (or any scheduler) can trigger it without deploying the worker
 * process. Reuses the same token as /cache/refresh.
 */
export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (!config.cacheRefreshToken || token !== config.cacheRefreshToken) {
      throw unauthorized("Invalid or missing indexer token");
    }

    logger.info("indexer", "POST /indexer/run start");
    const { logs, from, latest } = await runIndexer();
    logOk("indexer", "POST /indexer/run done", startedAt, {
      logs,
      from: from.toString(),
      latest: latest.toString(),
    });
    return json({
      ok: true,
      logs,
      from: from.toString(),
      latest: latest.toString(),
    });
  } catch (e) {
    return handleApiError(e);
  }
}