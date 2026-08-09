import "dotenv/config";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http, parseEventLogs, getAddress } from "viem";
import { celo } from "viem/chains";
import { config, STAKE_TOKEN_ADDRESS } from "../../lib/config";
import { arenaAbi, erc20Abi } from "../../lib/abi";
import { dbCollections } from "../../lib/db";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let apiBaseUrl = config.appBaseUrl;

/** Override the API base URL (defaults to APP_BASE_URL from .env). */
export function setApiBaseUrl(url: string) {
  apiBaseUrl = url;
}

export function assertSetup() {
  if (!config.contractAddress) throw new Error("CONTRACT_ADDRESS not set in .env");
  if (!config.appBaseUrl) throw new Error("APP_BASE_URL not set in .env");
}

/** Parse a .env hex private key into a viem account. */
export function accountFromPrivateKey(pk: string): PrivateKeyAccount {
  const cleaned = pk.trim().replace(/^0x/, "");
  return privateKeyToAccount(`0x${cleaned}` as `0x${string}`);
}

export function makeClients(account: PrivateKeyAccount) {
  const publicClient = createPublicClient({
    chain: celo,
    transport: http(config.celoRpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain: celo,
    transport: http(config.celoRpcUrl),
  });
  return { account, publicClient, walletClient };
}

export type ArenaClients = ReturnType<typeof makeClients>;

// ------------------------------------------------------------------ on-chain

export async function readContract(
  c: ArenaClients,
  functionName: "stakeAmount" | "feeBps" | "lobbyTimeout" | "matchTimeout"
): Promise<bigint | number> {
  return c.publicClient.readContract({
    address: config.contractAddress,
    abi: arenaAbi,
    functionName,
  });
}

export async function readStakeAmount(c: ArenaClients): Promise<bigint> {
  return c.publicClient.readContract({
    address: config.contractAddress,
    abi: arenaAbi,
    functionName: "stakeAmount",
  });
}

export async function ensureAllowance(c: ArenaClients, amount: bigint) {
  const arena = config.contractAddress;
  const allowance = await c.publicClient.readContract({
    address: STAKE_TOKEN_ADDRESS,
    abi: erc20Abi,
    functionName: "allowance",
    args: [c.account.address, arena],
  });
  if (allowance >= amount) return;
  console.log(
    `  approving USDT allowance ${amount.toString()} for ${arena} (currently ${allowance.toString()})`
  );
  const hash = await c.walletClient.writeContract({
    address: STAKE_TOKEN_ADDRESS,
    abi: erc20Abi,
    functionName: "approve",
    args: [arena, amount],
  });
  await c.publicClient.waitForTransactionReceipt({ hash });
}

/** Open a lobby and return its tournament id (parsed from the LobbyOpened event). */
export async function openLobby(c: ArenaClients): Promise<number> {
  const stake = await readStakeAmount(c);
  await ensureAllowance(c, stake);
  const hash = await c.walletClient.writeContract({
    address: config.contractAddress,
    abi: arenaAbi,
    functionName: "openLobby",
  });
  const receipt = await c.publicClient.waitForTransactionReceipt({ hash });
  const [ev] = parseEventLogs({
    logs: receipt.logs,
    abi: arenaAbi,
    eventName: "LobbyOpened",
  });
  if (!ev) throw new Error("LobbyOpened event not found in receipt");
  return Number(ev.args.id);
}

export async function acceptLobby(c: ArenaClients, id: number) {
  const stake = await readStakeAmount(c);
  await ensureAllowance(c, stake);
  const hash = await c.walletClient.writeContract({
    address: config.contractAddress,
    abi: arenaAbi,
    functionName: "acceptLobby",
    args: [BigInt(id)],
  });
  await c.publicClient.waitForTransactionReceipt({ hash });
}

export async function onChainTournament(c: ArenaClients, id: number) {
  return c.publicClient.readContract({
    address: config.contractAddress,
    abi: arenaAbi,
    functionName: "getTournament",
    args: [BigInt(id)],
  });
}

/** status as integer: Open=0, Locked=1, Settled=2, Refunded=3 */
export async function onChainStatus(c: ArenaClients, id: number): Promise<number> {
  const t = await onChainTournament(c, id);
  return Number(t.status);
}

// ------------------------------------------------------------------- HTTP

export class HttpError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(`HTTP ${status}: ${JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

async function apiFetch(
  path: string,
  init: RequestInit & { token?: string } = {}
): Promise<unknown> {
  const { token, headers, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl}${path}`, {
      ...rest,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(headers as Record<string, string>),
      },
    });
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new HttpError(res.status, body);
  return body;
}

/** POST /auth/nonce then POST /auth/verify with a signed message -> bearer token. */
export async function signIn(c: ArenaClients): Promise<string> {
  const { message } = (await apiFetch("/auth/nonce", {
    method: "POST",
    body: JSON.stringify({ address: c.account.address }),
  })) as { nonce: string; message: string };

  const signature = await c.account.signMessage({ message });
  const { token } = (await apiFetch("/auth/verify", {
    method: "POST",
    body: JSON.stringify({ address: c.account.address, signature }),
  })) as { token: string };

  return token;
}

export async function apiGet(path: string, token?: string): Promise<unknown> {
  return apiFetch(path, { token });
}

export async function apiPost(path: string, token: string, body: unknown): Promise<unknown> {
  return apiFetch(path, { method: "POST", body: JSON.stringify(body), token });
}

// ------------------------------------------------------------------ sessions

export type PlayResult = {
  served: number;
  solved: number;
  ratingSum: number;
  ended: "done" | "expired" | "error";
};

/**
 * The reference solving loop. Fetches puzzles one at a time and submits the
 * first solution move. `solve` may return null/undefined for a puzzle the agent
 * can't answer — the loop then submits a harmless wrong move and moves on.
 */
export async function playSession(
  c: ArenaClients,
  sessionId: string,
  opts: {
    token: string;
    solve?: (fen: string, puzzleId: string) => Promise<string | undefined>;
  }
): Promise<PlayResult> {
  const { token, solve } = opts;
  const result: PlayResult = { served: 0, solved: 0, ratingSum: 0, ended: "done" };
  const maxLoops = 1000;
  let loops = 0;

  while (loops++ < maxLoops) {
    let next: { done?: boolean; puzzleId?: string; fen?: string };
    try {
      next = (await apiGet(`/sessions/${sessionId}/puzzle/next`, token)) as {
        done?: boolean;
        puzzleId?: string;
        fen?: string;
      };
    } catch (e) {
      if (e instanceof HttpError && e.status === 410) {
        result.ended = "expired";
        break;
      }
      throw e;
    }

    if (next.done || !next.puzzleId) {
      result.ended = "done";
      break;
    }

    result.served++;
    let move: string | undefined;
    if (solve) {
      try {
        move = await solve(next.fen ?? "", next.puzzleId);
      } catch {
        move = undefined;
      }
    }
    if (!move) move = "a1a2"; // harmless wrong move keeps the loop advancing

    let submitted: { correct: boolean; ratingAwarded: number };
    try {
      submitted = (await apiPost(
        `/sessions/${sessionId}/puzzle/${next.puzzleId}/submit`,
        token,
        { move }
      )) as { correct: boolean; ratingAwarded: number };
    } catch (e) {
      if (e instanceof HttpError && e.status === 410) {
        result.ended = "expired";
        break;
      }
      throw e;
    }

    if (submitted.correct) {
      result.solved++;
      result.ratingSum += submitted.ratingAwarded;
    }
  }

  return result;
}

/**
 * Resolve a puzzle's first move from the cached DB collection. This is the
 * "oracle" solver used by tests/harness: it peeks at the solution stored
 * server-side (which the HTTP API deliberately never exposes).
 */
export async function solveFromDb(puzzleId: string): Promise<string | undefined> {
  const puzzles = await dbCollections().puzzles();
  const p = await puzzles.findOne({ _id: puzzleId });
  return p?.moves?.[0];
}

export function shortAddress(a: string): string {
  try {
    return getAddress(a);
  } catch {
    return a;
  }
}
