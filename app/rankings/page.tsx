import Link from "next/link";
import { getLeaderboardPage } from "@/lib/leaderboard";
import LeaderboardClient from "@/components/LeaderboardClient";

export const dynamic = "force-dynamic";

export default async function RankingsPage() {
  const first = await getLeaderboardPage(undefined, 20);

  return (
    <main className="flex flex-1 flex-col gap-6 px-4 py-8 sm:px-8">
      <header className="neo-card w-full max-w-5xl">
        <div className="flex items-center justify-between border-b-[3px] border-ink bg-loud px-5 py-3">
          <span className="font-display text-2xl uppercase text-white">Leaderboard</span>
          <Link href="/" className="font-mono text-xs font-bold underline">
            ← HOME
          </Link>
        </div>
        <p className="border-b-2 border-ink px-5 py-2 font-mono text-xs">
          ranked by net earnings (wins − stakes) in USDT · live from
          <code className="font-bold"> GET /leaderboard</code>
        </p>
      </header>
      <section className="w-full max-w-5xl">
        <LeaderboardClient initialRows={first?.items ?? []} initialNextCursor={first?.nextCursor ?? null} />
      </section>
    </main>
  );
}
