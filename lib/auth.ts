import { SignJWT, jwtVerify } from "jose";
import { recoverMessageAddress, getAddress } from "viem";
import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { config } from "./config";
import { dbCollections } from "./db";
import { ApiError, unauthorized } from "./http";

const NONCE_TTL_MS = 10 * 60 * 1000;
const TOKEN_TTL_SECONDS = 60 * 60; // 1h

const secret = () => new TextEncoder().encode(config.authJwtSecret);

export function buildMessage(address: string, nonce: string): string {
  return `Arena (${config.appBaseUrl})
Sign in with address: ${address}
Nonce: ${nonce}

This request will not trigger a blockchain transaction or cost any gas.`;
}

/** Issue a one-time, expiring nonce tied to a wallet address. */
export async function issueNonce(addressRaw: string): Promise<{ nonce: string; message: string }> {
  const address = getAddress(addressRaw);
  const nonce = randomBytes(32).toString("hex");
  const message = buildMessage(address, nonce);
  const nonces = await dbCollections().nonces();
  await nonces.updateOne(
    { _id: address },
    { $set: { nonce, message, expiresAt: Date.now() + NONCE_TTL_MS } },
    { upsert: true }
  );
  return { nonce, message };
}

/** Verify a personal_sign signature against a pending nonce, consume it, issue a JWT. */
export async function verifySignatureAndIssueToken(
  addressRaw: string,
  signature: `0x${string}`
): Promise<{ token: string; expiresAt: number }> {
  const address = getAddress(addressRaw);
  const nonces = await dbCollections().nonces();
  const doc = await nonces.findOne({ _id: address });
  if (!doc) throw unauthorized("No pending nonce for address");

  if (doc.expiresAt < Date.now()) {
    await nonces.deleteOne({ _id: address });
    throw unauthorized("Nonce expired");
  }

  let recovered: `0x${string}`;
  try {
    recovered = await recoverMessageAddress({ message: doc.message, signature });
  } catch {
    throw unauthorized("Invalid signature");
  }

  // One-time use regardless of outcome.
  await nonces.deleteOne({ _id: address });

  if (getAddress(recovered) !== address) throw unauthorized("Signature does not match address");

  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(address)
    .setIssuer(config.appBaseUrl)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .sign(secret());

  return { token, expiresAt: Date.now() + TOKEN_TTL_SECONDS * 1000 };
}

/** Decode + verify a bearer token, returning the checksummed wallet address. */
export async function verifyToken(token: string): Promise<`0x${string}`> {
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: config.appBaseUrl,
    });
    if (!payload.sub) throw unauthorized();
    return getAddress(payload.sub);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw unauthorized();
  }
}

/** Extract the wallet address from an Authorization: Bearer token. */
export async function requireAuth(request: NextRequest): Promise<`0x${string}`> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) throw unauthorized();
  return verifyToken(header.slice(7));
}
