/**
 * Leaderboard + usernames harness. Runs against a THROWAWAY MongoDB database
 * (default mongodb://127.0.0.1:27017/arena_test), wipes it, and verifies the
 * lib/leaderboard behaviours end-to-end. Refuses to run unless the database
 * name ends with "_test" so the real arena DB can never be touched.
 *
 *   pnpm test:leaderboard
 *   LEADERBOARD_TEST_MONGODB_URI=mongodb://127.0.0.1:27017/some_test pnpm test:leaderboard
 */

process.env.MONGODB_URI =
  process.env.LEADERBOARD_TEST_MONGODB_URI ?? "mongodb://127.0.0.1:27017/arena_test";
process.env.AUTH_JWT_SECRET = "leaderboard-test-secret";

import { getAddress } from "viem";

// Parse the database name without new URL(): Atlas multi-host URIs use
// comma-separated hosts, which are not valid WHATWG URLs. The db name is the
// last path segment before the query string.
const uriForGuard = process.env.MONGODB_URI ?? "";
const beforeQuery = uriForGuard.includes("?") ? uriForGuard.slice(0, uriForGuard.indexOf("?")) : uriForGuard;
const lastSlash = beforeQuery.lastIndexOf("/");
const dbName = lastSlash >= 0 ? beforeQuery.slice(lastSlash + 1) : "";
if (!dbName.endsWith("_test")) {
  console.error(
    `[leaderboard-test] refusing to run: database "${dbName}" does not end with "_test". ` +
      "Set LEADERBOARD_TEST_MONGODB_URI to a throwaway test database."
  );
  process.exit(1);
}

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);

let passed = 0;
let failed = 0;

function ok(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ok  ${msg}`);
  } else {
    failed++;
    console.error(`FAIL  ${msg}`);
  }
}

async function main() {
  // Wipe the throwaway DB BEFORE connecting through lib/db: a previous crashed
  // run may have left docs that violate the unique usernameLower index, which
  // would make getDb()'s index build fail at connect time.
  const { MongoClient } = await import("mongodb");
  const raw = new MongoClient(process.env.MONGODB_URI!, { serverSelectionTimeoutMS: 10000 });
  await raw.connect();
  await raw.db().dropDatabase();
  await raw.close();

  // Import AFTER setting MONGODB_URI so lib/config picks up the test DB.
  const { getDb, dbCollections, closeDb } = await import("../lib/db");
  const { validateUsername } = await import("../lib/usernames");
  const {
    ensureUser,
    renameUser,
    recordSettlement,
    getLeaderboardPage,
    searchUsers,
    getUserByUsername,
    getUserMatches,
    LeaderboardError,
  } = await import("../lib/leaderboard");

  await getDb();
  console.log(`[leaderboard-test] db=${dbName}`);

  const tournaments = await dbCollections().tournaments();
  const leaderboard = await dbCollections().leaderboard();

  // ---------------------------------------------------------------- usernames
  console.log("\nusernames & rename:");
  const A = addr(1);
  const B = addr(2);
  const C = addr(3);

  const a = await ensureUser(A);
  ok(validateUsername(a.username), `ensureUser(A) auto-assigns a valid username: ${a.username}`);
  ok(/^[a-z]+-[a-z]+-\d{3,4}$/.test(a.username), "auto name looks like adj-noun-####");

  const b = await ensureUser(B, "slyrook42");
  ok(b.username === "slyrook42", "ensureUser(B) claims the requested username");

  const c = await ensureUser(C, "bad name!"); // spaces + ! invalid
  ok(validateUsername(c.username), "invalid requested username falls back to auto");
  ok(c.username !== "bad name!", "invalid requested username is not used");

  const dup = await ensureUser(addr(4), "slyrook42"); // taken by B
  ok(validateUsername(dup.username) && dup.username !== "slyrook42", "taken username falls back to auto");

  const bAgain = await ensureUser(B, "something-else");
  ok(bAgain.username === "slyrook42", "later verifies return the stored username (requested ignored)");

  const renamed = await renameUser(B, "knight-tempo-9");
  ok(renamed.username === "knight-tempo-9", "renameUser(B) applies a new username");
  const found = await getUserByUsername("KNIGHT-TEMPO-9");
  ok(found?.username === "knight-tempo-9", "getUserByUsername is case-insensitive");

  let took = false;
  try {
    await renameUser(C, "knight-tempo-9");
  } catch (e) {
    took = e instanceof LeaderboardError && e.status === 409;
  }
  ok(took, "rename to a taken username throws 409 USERNAME_TAKEN");

  let cooled = false;
  try {
    await renameUser(B, "brand-new-name");
  } catch (e) {
    cooled = e instanceof LeaderboardError && e.status === 429;
  }
  ok(cooled, "immediate second rename throws 429 cooldown");

  let invalid = false;
  try {
    await renameUser(B, "no exclamation!");
  } catch (e) {
    invalid = e instanceof LeaderboardError && e.status === 400;
  }
  ok(invalid, "rename to an invalid username throws 400 USERNAME_INVALID");

  // allow rename again for later tests
  await leaderboard.updateOne({ _id: B }, { $set: { usernameChangedAt: null } });

  // ------------------------------------------------------------- settlements
  console.log("\nsettlement accounting:");
  const P = addr(10); // playerA / winner
  const Q = addr(11); // playerB / loser
  const t1 = 500;
  const stake = "1000000";
  const fee = 50000; // 5% of 2,000,000
  const pot = 2000000;
  await tournaments.insertOne({
    _id: t1,
    status: "Locked",
    playerA: P,
    playerB: Q,
    stakeA: stake,
    stakeB: stake,
    openedAt: 0,
    lockedAt: 0,
    serviced: true,
    generation: null,
    puzzleSubset: [],
    winner: null,
    fee: null,
    settleTx: null,
    refundTx: null,
    settleAttemptedAt: null,
    refundAttemptedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await recordSettlement(t1, P, fee); // settler path: called before status flips
  await tournaments.updateOne(
    { _id: t1 },
    { $set: { status: "Settled", winner: P, fee: String(fee), updatedAt: Date.now() } }
  );

  const pRow = await leaderboard.findOne({ _id: P });
  const qRow = await leaderboard.findOne({ _id: Q });
  ok(pRow?.tournamentsPlayed === 1 && pRow?.tournamentsWon === 1, "winner played=1 won=1");
  ok(pRow?.totalWon === pot - fee, `winner totalWon = pot - fee (${pot - fee})`);
  ok(pRow?.totalStaked === 1000000, "winner totalStaked = own stake");
  ok(pRow?.netEarned === pot - fee - 1000000, `winner netEarned = payout - stake (${pot - fee - 1000000})`);
  ok(qRow?.tournamentsPlayed === 1 && qRow?.tournamentsWon === 0, "loser played=1 won=0");
  ok(qRow?.netEarned === -1000000, "loser netEarned = -own stake");
  ok(
    pRow!.netEarned === pRow!.totalWon - pRow!.totalStaked &&
      qRow!.netEarned === qRow!.totalWon - qRow!.totalStaked,
    "netEarned === totalWon - totalStaked for both"
  );
  ok(
    pRow!.settledTournamentIds.includes(t1) && qRow!.settledTournamentIds.includes(t1),
    "settledTournamentIds records the tournament for both"
  );

  // idempotent replay
  await recordSettlement(t1, P, fee);
  const pRow2 = await leaderboard.findOne({ _id: P });
  ok(pRow2?.netEarned === pRow?.netEarned, "replaying a settlement does not double-count");

  // ------------------------------------------------------------------- profile
  // At this point P (netEarned 950000) is the only positive row -> rank 1.
  console.log("\nprofile & recent matches:");
  const winnerProfile = await getUserByUsername(pRow!.username);
  ok(winnerProfile !== null, "profile resolves for the winner");
  ok(winnerProfile!.address === getAddress(P), "profile carries the checksummed address");
  ok(winnerProfile!.rank === 1, "winner profile rank is live and correct");
  ok(
    winnerProfile!.recentMatches[0]!.tournamentId === t1 &&
      winnerProfile!.recentMatches[0]!.result === "win" &&
      winnerProfile!.recentMatches[0]!.opponentUsername === qRow!.username &&
      winnerProfile!.recentMatches[0]!.netChange === String(pot - fee - 1000000),
    "winner recent match shows opponent, result and netChange"
  );
  const loserMatches = await getUserMatches(Q);
  ok(
    loserMatches[0]!.result === "loss" && loserMatches[0]!.netChange === "-1000000",
    "loser recent match shows loss with -stake netChange"
  );
  ok((await getUserMatches(addr(999))).length === 0, "unknown address has no matches");

  // ------------------------------------------------------------------ ranking
  console.log("\nleaderboard ranking & pagination:");
  // 7 fresh players with distinct netEarned (values avoid ties entirely).
  // Earlier tests also left rows (P, Q, A, B, C, dup), so the collection has
  // more than just the seeded set — assertions below are count-agnostic.
  const nums = [7000000, 6000000, 5000000, 4000000, 3000000, 2000000, 1000000];
  const seeded = nums.map((n, i) => addr(100 + i));
  for (let i = 0; i < seeded.length; i++) {
    const net = nums[i]!;
    await ensureUser(seeded[i]!);
    await leaderboard.updateOne(
      { _id: seeded[i]! },
      { $set: { netEarned: net, totalWon: net + 1000000, totalStaked: 1000000, updatedAt: Date.now() } }
    );
  }

  const page1 = await getLeaderboardPage(undefined, 3);
  ok(page1 !== null && page1.items.length === 3, "page 1 returns the requested page size");
  ok(page1!.nextCursor !== null, "page 1 has a next cursor");
  const sorted1 = page1!.items.every(
    (it, i) => i === 0 || Number(page1!.items[i - 1]!.netEarned) > Number(it.netEarned)
  );
  ok(sorted1, "page 1 is ordered by netEarned desc");
  ok(page1!.items[0]!.netEarned === "7000000" && page1!.items[0]!.rank === 1, "top row is rank 1");

  // Walk every page until the cursor runs out: no dups, dense, desc, complete.
  const collected: { address: string; netEarned: string }[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let hadNext = false;
  do {
    const p = await getLeaderboardPage(cursor ?? undefined, 3);
    ok(p !== null, `page ${pages + 1} is valid`);
    if (p === null) break;
    if (pages === 0) ok(p.items[0]!.rank === 1, "first page starts at rank 1");
    else ok(p.items[0]!.rank === collected.length + 1, `page ${pages + 1} starts right after the previous page`);
    for (const it of p.items) {
      collected.push({ address: it.address, netEarned: it.netEarned });
      if (collected.length > 1) {
        const prev = collected[collected.length - 2]!.netEarned;
        ok(Number(prev) >= Number(it.netEarned), "rows stay sorted across pages (ties allowed)");
      }
    }
    cursor = p.nextCursor;
    hadNext = p.nextCursor !== null;
    pages++;
  } while (hadNext && pages < 20);
  ok(new Set(collected.map((r) => r.address)).size === collected.length, "all pages together have no duplicate rows");
  const totalRows = await leaderboard.countDocuments({});
  ok(collected.length === totalRows, "walking all pages covers every row exactly once");
  ok(pages > 1, "pagination actually spans multiple pages");

  // mid-pagination insert: a row inserted BETWEEN page fetches that sorts into
  // the next page must appear exactly once, with no dup or skip on either side.
  const mid1 = await getLeaderboardPage(undefined, 3); // top-3 BEFORE the insert
  const lastOfMid1 = Number(mid1!.items[2]!.netEarned); // cursor anchor (5M)
  const newcomer = addr(200);
  await ensureUser(newcomer);
  await leaderboard.updateOne(
    { _id: newcomer },
    { $set: { netEarned: lastOfMid1 - 500000, totalWon: lastOfMid1, totalStaked: 500000, updatedAt: Date.now() } }
  ); // sorts just BELOW the cursor -> belongs on the next page
  const mid2 = await getLeaderboardPage(mid1!.nextCursor!, 3);
  const midAll = [...mid1!.items, ...mid2!.items];
  ok(new Set(midAll.map((r) => r.address)).size === midAll.length, "mid-pagination insert does not duplicate");
  ok(midAll.filter((r) => r.address === newcomer).length === 1, "new leader appears exactly once after the insert");
  ok(midAll.length === 6, "pagination stays dense despite the mid-insert");

  // ------------------------------------------------------------------- search
  console.log("\nsearch:");
  await ensureUser(addr(300), "rookmaster");
  await ensureUser(addr(301), "rookqueen");
  await ensureUser(addr(302), "pawnstar");
  const rookHits = await searchUsers("rook");
  ok(rookHits.length >= 2, "search finds all substring matches");
  ok(rookHits.every((r) => r.username.toLowerCase().includes("rook")), "search is case-insensitive substring");
  ok(rookHits.length > 0 && rookHits[0]!.rank >= 1, "search results carry a live rank");
  const noHits = await searchUsers("zzzznotauser");
  ok(noHits.length === 0, "search with no matches returns []");

  // rank consistency between search and profile
  const searched = await searchUsers("rookmaster");
  const profiled = await getUserByUsername("ROOKMASTER");
  ok(searched[0]!.rank === profiled!.rank, "search rank matches profile rank");

  // ------------------------------------------------- rename + match resolution
  console.log("\nrename-mid-match (settlement is address-keyed):");
  const R = addr(20);
  await ensureUser(R, "finn");
  const qBefore = await leaderboard.findOne({ _id: Q });
  const qAutoName = qBefore!.username;
  await ensureUser(Q, "quiet-queen"); // Q exists from settlement -> must be a no-op
  const qAfterEnsure = await leaderboard.findOne({ _id: Q });
  ok(qAfterEnsure!.username === qAutoName, "ensureUser cannot change an existing username (no-op)");
  await renameUser(Q, "quiet-queen"); // Q never renamed -> no cooldown
  const qAfter = await leaderboard.findOne({ _id: Q });
  ok(qAfter?.username === "quiet-queen", "renameUser applies after the ensureUser no-op");
  await renameUser(R, "the-reaper");
  const rProfile = await getUserByUsername("THE-REAPER");
  ok(rProfile?.username === "the-reaper", "renamed profile resolves by new username");
  ok(rProfile!.address === getAddress(R), "rename does not change the address");
  const pMatchesAgain = await getUserMatches(P);
  ok(
    pMatchesAgain[0]!.opponentUsername === "quiet-queen",
    "recent matches resolve the opponent by ADDRESS -> updated username"
  );

  await closeDb();
  console.log(`\n[leaderboard-test] ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[leaderboard-test] fatal:", e);
  process.exit(1);
});
