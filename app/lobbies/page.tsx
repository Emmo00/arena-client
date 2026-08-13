import Link from "next/link";
import type { ReactNode } from "react";
import {
  listActiveLobbies,
  listOpenLobbies,
  nowEpochSeconds,
  resolveUsername,
} from "@/lib/lobbies";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ tab?: string }> };

type DirLobby = {
  id: number;
  creator: string;
  opponent: string | null;
  stakeA: string;
  openedAt: number;
  expiresAt: number;
};

export default async function LobbiesPage({ searchParams }: Props) {
  const { tab } = await searchParams;
  const active = tab === "active";

  const rows = active ? await listActiveLobbies(50) : await listOpenLobbies(50);

  const resolved = await Promise.all(
    rows.map(async (l) => {
      const creator = await resolveUsername(l.playerA);
      const opponent = l.playerB ? await resolveUsername(l.playerB) : null;
      return {
        id: l.id,
        creator,
        opponent,
        stakeA: l.stakeA,
        openedAt: l.openedAt,
        expiresAt: l.expiresAt,
      } satisfies DirLobby;
    })
  );

  const now = nowEpochSeconds();

  return (
    <main className="flex flex-1 flex-col gap-6 px-4 py-8 sm:px-8">
      <header className="flex w-full max-w-5xl items-center justify-between">
        <h1 className="font-display text-3xl uppercase">Lobbies</h1>
        <Link href="/" className="font-mono text-xs font-bold underline">
          ← ARENA
        </Link>
      </header>

      <nav className="neo-card flex w-full max-w-5xl">
        <Link
          href="/lobbies"
          className={`flex-1 px-4 py-2 text-center font-mono text-sm font-bold ${
            !active ? "border-b-[3px] border-ink bg-loud text-white" : "text-ink/60"
          }`}
        >
          OPEN {!active && `(${resolved.length})`}
        </Link>
        <Link
          href="/lobbies?tab=active"
          className={`flex-1 px-4 py-2 text-center font-mono text-sm font-bold ${
            active ? "border-b-[3px] border-ink bg-loud text-white" : "text-ink/60"
          }`}
        >
          ACTIVE {active && `(${resolved.length})`}
        </Link>
      </nav>

      <section className="neo-card w-full max-w-5xl">
        <div className="flex items-center justify-between border-b-[3px] border-ink bg-loud px-4 py-2">
          <h2 className="font-display text-lg uppercase text-white">
            {active ? "Active (matched) lobbies" : "Open lobbies"}
          </h2>
          <span className="font-mono text-xs font-bold text-white">
            {active ? "live" : "waiting for a challenger"}
          </span>
        </div>

        {resolved.length === 0 ? (
          <p className="p-4 font-mono text-sm">
            {active
              ? "no active matches right now."
              : "no open lobbies right now."}
          </p>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-ink text-left font-mono text-xs uppercase">
                <th className="px-3 py-2">id</th>
                <th className="px-3 py-2">player A · creator</th>
                {active && <th className="px-3 py-2">player B · challenger</th>}
                <th className="px-3 py-2">stakeA</th>
                <th className="px-3 py-2">opened</th>
                <th className="px-3 py-2">expires</th>
              </tr>
            </thead>
            <tbody className="font-mono text-sm">
              {resolved.map((l) => (
                <tr key={l.id} className="border-b border-ink/30">
                  <td className="px-3 py-2">
                    <Link href={`/lobby/${l.id}`} className="font-bold underline">
                      #{l.id}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{PlayerName(l.creator)}</td>
                  {active && <td className="px-3 py-2">{PlayerName(l.opponent)}</td>}
                  <td className="px-3 py-2">{toUsdt(l.stakeA)} USDT</td>
                  <td className="px-3 py-2">{ago(l.openedAt, now)}</td>
                  <td className="px-3 py-2">in {Math.max(0, l.expiresAt - now)}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

function PlayerName(name: string | null): ReactNode {
  if (!name) return <span className="text-ink/40">—</span>;
  if (name.startsWith("0x"))
    return (
      <span className="text-ink/60" title={name}>
        {name}
      </span>
    );
  return (
    <Link href={`/user/${name}`} className="underline">
      @{name}
    </Link>
  );
}

function ago(epochSeconds: number, now: number): string {
  const s = Math.floor(now - epochSeconds);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function toUsdt(atomic: string): string {
  const n = Number(atomic);
  if (!Number.isFinite(n)) return atomic;
  return (n / 1_000_000).toString();
}