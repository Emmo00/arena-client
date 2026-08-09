import "dotenv/config";
import {
  assertSetup,
  accountFromPrivateKey,
  acceptLobby,
  apiGet,
  apiPost,
  makeClients,
  onChainStatus,
  openLobby,
  playSession,
  setApiBaseUrl,
  signIn,
  sleep,
  solveFromDb,
  HttpError,
} from "./lib/arena";

const USAGE = `Usage: tsx scripts/agent.ts <command> [args]

Commands:
  open                  Open a lobby. Prints the tournament id. (needs --key)
  accept <id>           Accept lobby <id>. (needs --key)
  play <id>             Play tournament <id> to completion. (needs --key)
  status <id>           Show on-chain + API status of tournament <id>.
  nonce                 Debug auth: print address + signed nonce roundtrip.

Options:
  --key <privkey>       Agent private key (or set AGENT_PRIVATE_KEY env)
  --solver db|skip      db = look up real solutions in DB (default); skip = wrong moves
  --base-url <url>      Override API base URL
  --quiet               Suppress per-puzzle output
`;

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function keyOrThrow(): string {
  const k = flagValue("--key") ?? process.env.AGENT_PRIVATE_KEY ?? process.env.SETTLER_PRIVATE_KEY;
  if (!k) {
    console.error("No private key. Pass --key <pk> or set AGENT_PRIVATE_KEY.");
    process.exit(2);
  }
  return k;
}

async function waitForIndexed(id: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await apiGet(`/lobbies/${id}`);
      return;
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 404) throw e;
    }
    await sleep(2000);
  }
  throw new Error(`tournament ${id} never indexed within 60s (is the indexer running?)`);
}

async function cmdOpen() {
  const account = accountFromPrivateKey(keyOrThrow());
  const c = makeClients(account);
  console.log(`agent: ${account.address}`);
  const id = await openLobby(c);
  console.log(`tournamentId=${id}`);
}

async function cmdAccept(id: number) {
  const account = accountFromPrivateKey(keyOrThrow());
  const c = makeClients(account);
  console.log(`agent: ${account.address}`);
  await acceptLobby(c, id);
  console.log(`accepted tournamentId=${id}`);
}

async function cmdPlay(id: number) {
  const account = accountFromPrivateKey(keyOrThrow());
  const c = makeClients(account);
  const solver = flagValue("--solver") ?? "db";
  const quiet = hasFlag("--quiet");

  console.log(`agent: ${account.address}`);
  console.log(`playing tournamentId=${id} solver=${solver}`);
  await waitForIndexed(id);

  const token = await signIn(c);
  const start = (await apiPost(`/sessions/start`, token, {
    tournamentId: id,
  })) as { sessionId: string };

  console.log(`sessionId=${start.sessionId}`);
  const result = await playSession(c, start.sessionId, {
    token,
    solve:
      solver === "db"
        ? async (_fen: string, puzzleId: string) => solveFromDb(puzzleId)
        : undefined,
  });

  if (!quiet) console.log(`session result: ${JSON.stringify(result)}`);
  const t = (await apiGet(`/tournaments/${id}`, token)) as {
    status: string;
    winner: string | null;
  };
  console.log(`tournament status=${t.status} winner=${t.winner ?? "none"}`);
  console.log(`RESULT ${JSON.stringify({ tournamentId: id, ...result })}`);
}

async function cmdStatus(id: number) {
  assertSetup();
  const account = accountFromPrivateKey(keyOrThrow());
  const c = makeClients(account);
  const status = await onChainStatus(c, id);
  const names = ["Open", "Locked", "Settled", "Refunded"];
  console.log(`on-chain status=${status} (${names[status] ?? "?"})`);
  try {
    const token = await signIn(c);
    const t = await apiGet(`/tournaments/${id}`, token);
    console.log(`api: ${JSON.stringify(t)}`);
  } catch (e) {
    if (e instanceof HttpError) {
      console.log(`api: HTTP ${e.status} ${JSON.stringify(e.body)}`);
    } else {
      throw e;
    }
  }
}

async function cmdNonce() {
  assertSetup();
  const account = accountFromPrivateKey(keyOrThrow());
  const c = makeClients(account);
  const token = await signIn(c);
  console.log(`address=${account.address}`);
  console.log(`token ok (${token.length} chars)`);
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd) {
    console.error(USAGE);
    process.exit(2);
  }

  assertSetup();
  const baseUrl = flagValue("--base-url");
  if (baseUrl) setApiBaseUrl(baseUrl);

  const idArg = process.argv[3];
  const id = idArg !== undefined ? Number(idArg) : NaN;

  switch (cmd) {
    case "open":
      await cmdOpen();
      break;
    case "accept":
      if (!Number.isInteger(id)) throw new Error("accept requires <id>");
      await cmdAccept(id);
      break;
    case "play":
      if (!Number.isInteger(id)) throw new Error("play requires <id>");
      await cmdPlay(id);
      break;
    case "status":
      if (!Number.isInteger(id)) throw new Error("status requires <id>");
      await cmdStatus(id);
      break;
    case "nonce":
      await cmdNonce();
      break;
    default:
      console.error(USAGE);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(`[agent] error:`, e);
  process.exit(1);
});
