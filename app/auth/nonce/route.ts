import { NextRequest } from "next/server";
import { getAddress } from "viem";
import { issueNonce } from "@/lib/auth";
import { badRequest, handleApiError, json, logOk } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const body = await request.json();
    if (typeof body?.address !== "string" || !body.address.startsWith("0x")) {
      throw badRequest("address required");
    }
    let address: `0x${string}`;
    try {
      address = getAddress(body.address);
    } catch {
      throw badRequest("invalid address");
    }
    const { nonce, message } = await issueNonce(address);
    logOk("auth", "POST /auth/nonce ok", startedAt, { address });
    return json({ nonce, message });
  } catch (e) {
    return handleApiError(e);
  }
}
