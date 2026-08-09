import { createHmac, timingSafeEqual } from "node:crypto";
import { decodeEventLog } from "viem";
import { arenaAbi } from "@/lib/abi";
import { config } from "@/lib/config";
import { handleApiError } from "@/lib/http";
import { processArenaEvent, type ArenaEventName } from "@/lib/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const EVENT_NAMES = new Set<ArenaEventName>([
  "LobbyOpened",
  "LobbyAccepted",
  "Settled",
  "LobbyRefunded",
  "LockedLobbyRefunded",
]);

type AlchemyLog = {
  topics?: string[];
  data?: string;
  account?: { address?: string };
  transaction?: { hash?: string };
};

type AlchemyBlock = {
  number?: string | number;
  timestamp?: string | number;
  logs?: AlchemyLog[];
};

type GraphqlPayload = {
  webhookId?: string;
  id?: string;
  createdAt?: string;
  type?: string;
  event?: {
    data?: { block?: AlchemyBlock };
    sequenceNumber?: string;
  };
};

function isValidSignature(rawBody: string, signature: string): boolean {
  if (!config.alchemyWebhookSigningKey) return false;
  const digest = createHmac("sha256", config.alchemyWebhookSigningKey)
    .update(rawBody, "utf8")
    .digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(digest);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get("x-alchemy-signature") ?? "";
    if (!isValidSignature(rawBody, signature)) {
      return new Response(
        JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Invalid signature" } }),
        { status: 401, headers: { "content-type": "application/json" } }
      );
    }

    const payload = JSON.parse(rawBody) as GraphqlPayload;
    const block = payload.event?.data?.block;
    if (!block?.logs?.length) {
      return new Response(JSON.stringify({ ok: true, processed: 0 }), {
        headers: { "content-type": "application/json" },
      });
    }

    const timestamp = block.timestamp !== undefined ? Number(block.timestamp) : 0;
    let processed = 0;

    for (const log of block.logs) {
      if (!log.topics?.length) continue;
      const decoded = decodeEventLog({
        abi: arenaAbi,
        topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
        data: (log.data ?? "0x") as `0x${string}`,
      });
      const eventName = decoded.eventName as ArenaEventName;
      if (!EVENT_NAMES.has(eventName)) continue;
      const args = decoded.args as Record<string, unknown>;
      await processArenaEvent({
        eventName,
        id: args.id as bigint,
        playerA: args.playerA as string | undefined,
        playerB: args.playerB as string | undefined,
        winner: args.winner as string | undefined,
        stake: args.stake as bigint | undefined,
        fee: args.fee as bigint | undefined,
        transactionHash: log.transaction?.hash ?? "",
        timestamp,
      });
      processed++;
    }

    return new Response(JSON.stringify({ ok: true, processed }), {
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return handleApiError(e);
  }
}
