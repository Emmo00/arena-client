import { NextRequest } from "next/server";
import { getAddress } from "viem";
import { verifySignatureAndIssueToken } from "@/lib/auth";
import { badRequest, handleApiError, json } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (typeof body?.address !== "string" || !body.address.startsWith("0x")) {
      throw badRequest("address required");
    }
    if (typeof body?.signature !== "string" || !body.signature.startsWith("0x")) {
      throw badRequest("signature required");
    }
    let address: `0x${string}`;
    try {
      address = getAddress(body.address);
    } catch {
      throw badRequest("invalid address");
    }
    const username =
      typeof body?.username === "string" && body.username.trim()
        ? body.username.trim()
        : undefined;
    const { token, expiresAt, username: finalUsername } = await verifySignatureAndIssueToken(
      address,
      body.signature as `0x${string}`,
      username
    );
    return json({ token, expiresAt, username: finalUsername });
  } catch (e) {
    return handleApiError(e);
  }
}
