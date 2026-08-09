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
  readContract,
  setApiBaseUrl,
  signIn,
  sleep,
  solveFromDb,
  HttpError,
  type ArenaClients,
} from "./lib/arena";

const USAGE = `Runs a full match end-to-end against the live deployment:
  playerA opens a lobby -> playerB accepts -> both run sessions -> settler settles.

WARNING: this spends REAL money on-chain (stake x2 + gas) when run against mainnet.

Options:
  --a-key <pk>     Player A private key (or env E2E_PLAYER_A_PRIVATE_KEY)
  --b-key <pk>     Player B private key (or env E2E_PLAYER_B_PRIVATE_KEY)
  --a-solver db|skip   player A solver (default db)
  --b-solver db|skip   player B solver (default skip — makes A win deterministically)
  --base-url <url> Override API base URL
  --yes            Skip the confirmation prompt
  --quiet          Less output
`;

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function keyOrEnv(flag: string, env: string): string {
  return flagValue(flag) ?? process.env[env] ?? "";
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

async function waitForLocked(id: number): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const body = (await apiGet(`/lobbies/${id}`)) as { status: string };
    if (body.status === "Locked") return;
    await sleep(2000);
  }
  throw new Error(`tournament ${id} never became Locked within 90s`);
}

async function waitForSettled(
  c: ArenaClients,
  id: number,
  token: string
): Promise<{ winner: string | null; fee: string | null }> {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const status = await onChainStatus(c, id);
    if (status === 2) {
      const t = (await apiGet(`/tournaments/${id}`, token)) as {
        winner: string | null;
        fee: string | null;
      };
      return { winner: t.winner, fee: t.fee };
    }
    if (status === 3) {
      throw new Error(`tournament ${id} was Refunded instead of Settled`);
    }
    await sleep(3000);
  }
  throw new Error(`tournament ${id} never settled within 240s`);
}

async function confirm(): Promise<void> {
  if (hasFlag("--yes") || process.env.E2E_YES === "1") return;
  console.error(
    `\nWARNING: this runs against the LIVE deployment and spends real funds.\nRun with --yes to continue, or --base-url http://localhost:3000 for a local run.\n\n${USAGE}\n`
  );
  process.exit(2);
}

async function main() {
  assertSetup();
  const baseUrl = flagValue("--base-url");
  if (baseUrl) setApiBaseUrl(baseUrl);
  await confirm();

  const pkA = keyOrEnv("--a-key", "E2E_PLAYER_A_PRIVATE_KEY");
  const pkB = keyOrEnv("--b-key", "E2E_PLAYER_B_PRIVATE_KEY");
  if (!pkA || !pkB) {
    console.error("Need player keys: --a-key / --b-key or E2E_PLAYER_A/B_PRIVATE_KEY env.");
    process.exit(2);
  }
  const solverA = flagValue("--a-solver") ?? "db";
  const solverB = flagValue("--b-solver") ?? "skip";
  const quiet = hasFlag("--quiet");

  const ca = makeClients(accountFromPrivateKey(pkA));
  const cb = makeClients(accountFromPrivateKey(pkB));
  const tokenA = await signIn(ca);
  const tokenB = await signIn(cb);

  const stakeAmount = (await readContract(ca, "stakeAmount")) as bigint;
  const feeBps = Number(await readContract(ca, "feeBps"));
  const expectedFee = (2n * stakeAmount * BigInt(feeBps)) / 10000n;

  console.log(`playerA=${ca.account.address}`);
  console.log(`playerB=${cb.account.address}`);
  console.log(`stakeAmount=${stakeAmount} feeBps=${feeBps} expectedFee=${expectedFee}`);

  // 1. A opens a lobby
  console.log("[1] playerA openLobby ...");
  const id = await openLobby(ca);
  console.log(`    tournamentId=${id}`);
  await waitForIndexed(id);

  // 2. B accepts
  console.log("[2] playerB acceptLobby ...");
  await acceptLobby(cb, id);
  await waitForLocked(id);

  // 3. both start sessions and play concurrently
  console.log("[3] sessions start ...");
  const [sa, sb] = await Promise.all([
    apiPost(`/sessions/start`, tokenA, { tournamentId: id }),
    apiPost(`/sessions/start`, tokenB, { tournamentId: id }),
  ]) as [ { sessionId: string }, { sessionId: string } ];

  console.log(`    A session=${sa.sessionId}`);
  console.log(`    B session=${sb.sessionId}`);

  const [resA, resB] = await Promise.all([
    playSession(ca, sa.sessionId, {
      token: tokenA,
      solve:
        solverA === "db"
          ? async (_fen: string, puzzleId: string) => solveFromDb(puzzleId)
          : undefined,
    }),
    playSession(cb, sb.sessionId, {
      token: tokenB,
      solve:
        solverB === "db"
          ? async (_fen: string, puzzleId: string) => solveFromDb(puzzleId)
          : undefined,
    }),
  ]);
  if (!quiet) {
    console.log(`    A: ${JSON.stringify(resA)}`);
    console.log(`    B: ${JSON.stringify(resB)}`);
  }

  // 4. settler settles
  console.log("[4] waiting for settler ...");
  const { winner, fee } = await waitForSettled(ca, id, tokenA);
  console.log(`    winner=${winner} fee=${fee}`);

  // 5. assertions
  const failures: string[] = [];
  if (winner !== ca.account.address) {
    failures.push(`expected winner ${ca.account.address}, got ${winner}`);
  }
  if (fee !== expectedFee.toString()) {
    failures.push(`expected fee ${expectedFee.toString()}, got ${fee}`);
  }
  const onchain = await onChainStatus(ca, id);
  if (onchain !== 2) {
    failures.push(`expected on-chain status 2 (Settled), got ${onchain}`);
  }

  if (failures.length > 0) {
    console.error(`E2E FAILED:\n  - ${failures.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("E2E PASS");
}

main().catch((e) => {
  console.error(`[e2e] error:`, e);
  process.exit(1);
});
