import Link from "next/link";
import { notFound } from "next/navigation";
import { getUserByUsername } from "@/lib/leaderboard";
import type { RecentMatch } from "@/lib/leaderboard";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ username: string }> };

export default async function UserPage({ params }: Params) {
  const { username } = await params;
  const user = await getUserByUsername(username);
  if (!user) notFound();

  return (
    <main className="flex flex-1 flex-col gap-6 px-4 py-8 sm:px-8">
      <header className="neo-card w-full max-w-5xl">
        <div className="flex items-center justify-between border-b-[3px] border-ink bg-loud px-5 py-3">
          <span className="font-display text-2xl uppercase text-white">@{user.username}</span>
          <Link href="/rankings" className="font-mono text-xs font-bold underline">
            ← LEADERBOARD
          </Link>
        </div>
        <div className="grid gap-6 p-5 sm:grid-cols-2">
          <div className="neo-card bg-white p-4">
            <p className="font-mono text-xs uppercase text-ink/60">rank · net earned</p>
            <p className="mt-1 font-display text-4xl uppercase">#{user.rank}</p>
            <p className={`mt-2 font-mono text-sm ${netNum(user.netEarned) < 0 ? "text-loud" : ""}`}>
              {fmtUsd(user.netEarned)} net
            </p>
            <p className="mt-1 font-mono text-xs text-ink/60">address</p>
            <p className="break-all font-mono text-xs">{user.address}</p>
          </div>
          <div className="flex flex-col gap-3">
            <div className="neo-card bg-white p-4">
              <p className="font-mono text-xs uppercase text-ink/60">record</p>
              <p className="mt-1 font-mono text-sm">
                <b>{user.tournamentsPlayed}</b> played · <b>{user.tournamentsWon}</b> won ·{" "}
                <b>{user.tournamentsPlayed - user.tournamentsWon}</b> lost
              </p>
            </div>
            <div className="neo-card bg-white p-4">
              <p className="font-mono text-xs uppercase text-ink/60">lifetime</p>
              <p className="mt-1 font-mono text-sm">
                staked {fmtUsd(user.totalStaked)} · won {fmtUsd(user.totalWon)}
              </p>
            </div>
          </div>
        </div>
      </header>

      <section className="w-full max-w-5xl">
        <div className="neo-card">
          <div className="flex items-center justify-between border-b-[3px] border-ink bg-buzz px-4 py-2">
            <h2 className="font-display text-lg uppercase">Recent matches</h2>
            <span className="font-mono text-xs font-bold">GET /users/:username</span>
          </div>
          <div className="p-4">
            {user.recentMatches.length === 0 && (
              <p className="font-mono text-sm">no settled matches yet.</p>
            )}
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b-2 border-ink text-left font-mono text-xs uppercase">
                  <th className="px-2 py-1">tournament</th>
                  <th className="px-2 py-1">vs</th>
                  <th className="px-2 py-1">result</th>
                  <th className="px-2 py-1 text-right">net</th>
                </tr>
              </thead>
              <tbody className="font-mono text-sm">
                {user.recentMatches.map((m: RecentMatch) => (
                  <tr key={m.tournamentId} className="border-b border-ink/30">
                    <td className="px-2 py-1 font-bold">#{m.tournamentId}</td>
                    <td className="px-2 py-1">
                      <Link href={`/user/${m.opponentUsername}`} className="font-bold underline">
                        {m.opponentUsername}
                      </Link>
                    </td>
                    <td className={`px-2 py-1 ${m.result === "win" ? "text-ink" : "text-loud"}`}>
                      {m.result}
                    </td>
                    <td className={`px-2 py-1 text-right ${netNum(m.netChange) < 0 ? "text-loud" : ""}`}>
                      {fmtUsd(m.netChange)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>
  );
}

function netNum(atomic: string): number {
  const n = Number(atomic);
  return Number.isFinite(n) ? n : 0;
}

function fmtUsd(atomic: string): string {
  const n = netNum(atomic) / 1_000_000;
  const neg = n < 0;
  return `${neg ? "−" : ""}$${Math.abs(n).toFixed(2)}`;
}
