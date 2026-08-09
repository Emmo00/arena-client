#!/usr/bin/env node
// Arena — standalone chess-puzzle agent (single file, no repo needed).
//
// Requires: Node 18+ and one dependency:  npm i viem@^2
//
// Setup:
//   export AGENT_PRIVATE_KEY=0x...                    # wallet funded with CELO (gas) + USDT (stake)
//   export CONTRACT_ADDRESS=0x...                     # Arena contract (see /llms.txt)
//   export APP_BASE_URL=https://arena.chesspuzzles.xyz   # optional
//   export CELO_RPC_URL=https://forno.celo.org           # optional
//
// Commands:
//   node agent.mjs open                   # open a lobby -> prints tournamentId
//   node agent.mjs lobbies                # list open lobbies
//   node agent.mjs accept <id>            # accept an Open lobby
//   node agent.mjs play <id>              # play a tournament to completion
//   node agent.mjs status <id>            # on-chain + API status
//   node agent.mjs nonce                  # debug auth roundtrip
//
// Solving: the play loop calls solvePuzzle(fen, puzzleId) below. Edit it to
// return the first SAN move for a position, or run with --solver '<cmd>' to
// pipe the FEN (stdin) to your own solver and read the move from stdout.
// With no solver it submits "a1a2", which advances the loop but is scored wrong.

import { createPublicClient, createWalletClient, http, parseAbi, parseEventLogs } from "viem";
import { celo } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const APP_BASE_URL = process.env.APP_BASE_URL ?? "https://arena.chesspuzzles.xyz";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS ?? "";
const CELO_RPC_URL = process.env.CELO_RPC_URL ?? "https://forno.celo.org";
const STAKE_TOKEN = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e"; // Celo mainnet USDT, 6 decimals

if (!CONTRACT_ADDRESS) {
  console.error("CONTRACT_ADDRESS not set. Export it (see /llms.txt).");
  process.exit(2);
}

const arenaAbi = parseAbi([
  "event LobbyOpened(uint256 indexed id, address indexed playerA, uint256 stake)",
  "event LobbyAccepted(uint256 indexed id, address indexed playerB)",
  "event Settled(uint256 indexed id, address indexed winner, uint256 fee)",
  "function openLobby() returns (uint256)",
  "function acceptLobby(uint256)",
  "function refundLobby(uint256)",
  "function refundLockedLobby(uint256)",
  "function getTournament(uint256) returns (address playerA, address playerB, uint256 stakeA, uint256 stakeB, uint8 status, uint256 openedAt, uint256 lockedAt)",
  "function stakeAmount() returns (uint256)",
]);

const erc20Abi = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) returns (uint256)",
  "function balanceOf(address) returns (uint256)",
]);

const STATUS_NAMES = ["Open", "Locked", "Settled", "Refunded"];

// ------------------------------------------------------------------ on-chain

function makeClients(account) {
  const transport = http(CELO_RPC_URL);
  return {
    account,
    publicClient: createPublicClient({ chain: celo, transport }),
    walletClient: createWalletClient({ account, chain: celo, transport }),
  };
}

async function readStakeAmount(c) {
  return c.publicClient.readContract({ address: CONTRACT_ADDRESS, abi: arenaAbi, functionName: "stakeAmount" });
}

async function ensureStake(c) {
  const stake = await readStakeAmount(c);
  const bal = await c.publicClient.readContract({
    address: STAKE_TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [c.account.address],
  });
  if (bal < stake) {
    throw new Error(`USDT balance too low: ${Number(bal) / 1e6} < stake ${Number(stake) / 1e6}`);
  }
  const allowance = await c.publicClient.readContract({
    address: STAKE_TOKEN, abi: erc20Abi, functionName: "allowance", args: [c.account.address, CONTRACT_ADDRESS],
  });
  if (allowance < stake) {
    console.log(`  approving USDT ${Number(stake) / 1e6} for the Arena contract`);
    const hash = await c.walletClient.writeContract({
      address: STAKE_TOKEN, abi: erc20Abi, functionName: "approve", args: [CONTRACT_ADDRESS, stake],
    });
    await c.publicClient.waitForTransactionReceipt({ hash });
  }
  return stake;
}

async function openLobby(c) {
  await ensureStake(c);
  const hash = await c.walletClient.writeContract({ address: CONTRACT_ADDRESS, abi: arenaAbi, functionName: "openLobby" });
  const receipt = await c.publicClient.waitForTransactionReceipt({ hash });
  const [ev] = parseEventLogs({ logs: receipt.logs, abi: arenaAbi, eventName: "LobbyOpened" });
  if (!ev) throw new Error("LobbyOpened event not found in receipt");
  return Number(ev.args.id);
}

async function acceptLobby(c, id) {
  await ensureStake(c);
  const hash = await c.walletClient.writeContract({
    address: CONTRACT_ADDRESS, abi: arenaAbi, functionName: "acceptLobby", args: [BigInt(id)],
  });
  await c.publicClient.waitForTransactionReceipt({ hash });
}

async function onChainStatus(c, id) {
  const t = await c.publicClient.readContract({
    address: CONTRACT_ADDRESS, abi: arenaAbi, functionName: "getTournament", args: [BigInt(id)],
  });
  return Number(t.status);
}

// ------------------------------------------------------------------- HTTP

class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

async function apiFetch(path, { token, method = "GET", body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let res;
  try {
    res = await fetch(`${APP_BASE_URL}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new HttpError(res.status, data);
  return data;
}

const apiGet = (path, token) => apiFetch(path, { token });
const apiPost = (path, body, token) => apiFetch(path, { method: "POST", body, token });

async function signIn(c) {
  const { message } = await apiPost("/auth/nonce", { address: c.account.address });
  const signature = await c.account.signMessage({ message });
  const { token } = await apiPost("/auth/verify", { address: c.account.address, signature });
  return token;
}

// ---------------------------------------------------------------- solving

/** EDIT THIS: return the first SAN move for a position, or undefined to skip. */
async function solvePuzzle(_fen, _puzzleId) {
  return undefined;
}

async function runExternalSolver(cmd, fen) {
  const [file, ...args] = cmd.split(/\s+/).filter(Boolean);
  const { stdout } = await execFileP(file, args, { input: fen, timeout: 15_000 });
  const move = String(stdout).trim().split(/\n/)[0];
  return move || undefined;
}

async function playSession(c, sessionId, token, { solve, quiet }) {
  const result = { served: 0, solved: 0, ratingSum: 0, ended: "done" };
  for (let loops = 0; loops < 1000; loops++) {
    let next;
    try {
      next = await apiGet(`/sessions/${sessionId}/puzzle/next`, token);
    } catch (e) {
      if (e instanceof HttpError && e.status === 410) { result.ended = "expired"; break; }
      throw e;
    }
    if (next.done || !next.puzzleId) break;
    result.served++;
    let move;
    if (solve) {
      try { move = await solve(next.fen ?? "", next.puzzleId); } catch { move = undefined; }
    }
    if (!move) move = "a1a2";
    let submitted;
    try {
      submitted = await apiPost(`/sessions/${sessionId}/puzzle/${next.puzzleId}/submit`, { move }, token);
    } catch (e) {
      if (e instanceof HttpError && e.status === 410) { result.ended = "expired"; break; }
      throw e;
    }
    if (submitted.correct) {
      result.solved++;
      result.ratingSum += submitted.ratingAwarded;
    }
    if (!quiet) console.log(`puzzle ${result.served}: ${submitted.correct ? `solved +${submitted.ratingAwarded}` : "wrong"} (${move})`);
  }
  return result;
}

// --------------------------------------------------------------- commands

function keyOrThrow() {
  const k = process.env.AGENT_PRIVATE_KEY;
  if (!k) {
    console.error("No private key. Export AGENT_PRIVATE_KEY.");
    process.exit(2);
  }
  return k;
}

function accountFromKey(pk) {
  const cleaned = pk.trim().replace(/^0x/, "");
  return privateKeyToAccount(`0x${cleaned}`);
}

async function waitForIndexed(id) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await apiGet(`/lobbies/${id}`);
      return;
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 404) throw e;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`tournament ${id} never indexed within 60s`);
}

async function cmdOpen() {
  const account = accountFromKey(keyOrThrow());
  const c = makeClients(account);
  console.log(`agent: ${account.address}`);
  try {
    const { count, capacity } = await apiGet("/lobbies/open");
    if (count >= capacity) {
      console.warn(`WARNING: app is at lobby capacity (${count}/${capacity}). A new lobby may be opened`);
      console.warn(`on-chain but never serviced (serviced:false); stake would sit until lobbyTimeout,`);
      console.warn(`then anyone can refundLobby(id). Consider waiting for an open slot.`);
    }
  } catch {
    // capacity check is advisory; never block opening on it.
  }
  const id = await openLobby(c);
  console.log(`tournamentId=${id}`);
}

async function cmdLobbies() {
  const { lobbies } = await apiGet("/lobbies/open");
  console.log(JSON.stringify(lobbies, null, 2));
}

async function cmdAccept(id) {
  const account = accountFromKey(keyOrThrow());
  const c = makeClients(account);
  console.log(`agent: ${account.address}`);
  await acceptLobby(c, id);
  console.log(`accepted tournamentId=${id}`);
}

async function cmdPlay(id, opts) {
  const account = accountFromKey(keyOrThrow());
  const c = makeClients(account);
  console.log(`agent: ${account.address}`);
  await waitForIndexed(id);
  const token = await signIn(c);
  const { sessionId } = await apiPost("/sessions/start", { tournamentId: id }, token);
  console.log(`sessionId=${sessionId}`);
  const result = await playSession(c, sessionId, token, {
    solve: opts.solverExec ? (fen) => runExternalSolver(opts.solverExec, fen) : solvePuzzle,
    quiet: opts.quiet,
  });
  if (!opts.quiet) console.log(`session result: ${JSON.stringify(result)}`);
  const t = await apiGet(`/tournaments/${id}`, token);
  console.log(`tournament status=${t.status} winner=${t.winner ?? "none"}`);
  console.log(`RESULT ${JSON.stringify({ tournamentId: id, ...result })}`);
}

async function cmdStatus(id) {
  const account = accountFromKey(keyOrThrow());
  const c = makeClients(account);
  const status = await onChainStatus(c, id);
  console.log(`on-chain status=${status} (${STATUS_NAMES[status] ?? "?"})`);
  try {
    const token = await signIn(c);
    const t = await apiGet(`/tournaments/${id}`, token);
    console.log(`api: ${JSON.stringify(t, null, 2)}`);
  } catch (e) {
    if (e instanceof HttpError) console.log(`api: HTTP ${e.status} ${JSON.stringify(e.body)}`);
    else throw e;
  }
}

async function cmdNonce() {
  const account = accountFromKey(keyOrThrow());
  const c = makeClients(account);
  const token = await signIn(c);
  console.log(`address=${account.address}`);
  console.log(`token ok (${token.length} chars)`);
}

// ------------------------------------------------------------------- main

function flagValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd) {
    console.error(`Usage: node agent.mjs <open|lobbies|accept|play|status|nonce> [id]
  --solver '<cmd>'        pipe FEN (stdin) to your solver, read SAN move from stdout
  --quiet                 suppress per-puzzle output`);
    process.exit(2);
  }
  const idArg = process.argv[3];
  const id = idArg !== undefined ? Number(idArg) : NaN;
  const solverRaw = flagValue("--solver");
  const opts = {
    solverExec: solverRaw && solverRaw !== "skip" ? solverRaw : undefined,
    quiet: hasFlag("--quiet"),
  };
  switch (cmd) {
    case "open": await cmdOpen(); break;
    case "lobbies": await cmdLobbies(); break;
    case "accept":
      if (!Number.isInteger(id)) throw new Error("accept requires <id>");
      await cmdAccept(id);
      break;
    case "play":
      if (!Number.isInteger(id)) throw new Error("play requires <id>");
      await cmdPlay(id, opts);
      break;
    case "status":
      if (!Number.isInteger(id)) throw new Error("status requires <id>");
      await cmdStatus(id);
      break;
    case "nonce": await cmdNonce(); break;
    default: console.error(`Unknown command: ${cmd}`); process.exit(2);
  }
}

main().catch((e) => {
  console.error(`[agent] error:`, e instanceof Error ? e.message : e);
  process.exit(1);
});
