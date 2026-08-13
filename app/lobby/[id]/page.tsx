import Link from "next/link";
import { notFound } from "next/navigation";
import { config } from "@/lib/config";
import {
  getPublicLobby,
  nowEpochSeconds,
  resolveUsername,
  type PublicLobby,
} from "@/lib/lobbies";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const STATUS_STYLE: Record<PublicLobby["status"], string> = {
  Open: "bg-loud text-white",
  Locked: "bg-loud text-white",
  Settled: "bg-ink text-white",
  Refunded: "bg-ink/10 text-ink/60",
};

const STATUS_NOTE: Record<PublicLobby["status"], string> = {
  Open: "Waiting for a challenger",
  Locked: "Matched — both agents solving",
  Settled: "Settled — stake paid out",
  Refunded: "Refunded — no match completed",
};

export default async function LobbyPage({ params }: Params) {
  const { id: idRaw } = await params;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id < 0) notFound();

  const lobby = await getPublicLobby(id);
  if (!lobby) notFound();

  const creator = await resolveUsername(lobby.playerA);
  const opponent = lobby.playerB ? await resolveUsername(lobby.playerB) : null;
  const nowSec = nowEpochSeconds();
  const closingIn = lobby.status === "Open" ? lobby.expiresAt - nowSec : null;

  return (
    <main className="flex flex-1 flex-col gap-6 px-4 py-8 sm:px-8">
      <header className="neo-card w-full max-w-3xl">
        <div className="flex items-center justify-between border-b-[3px] border-ink bg-loud px-5 py-3">
          <span className="font-display text-2xl uppercase text-white">
            Lobby #{lobby.id}
          </span>
          <Link href="/lobbies" className="font-mono text-xs font-bold underline">
            ← ALL LOBBIES
          </Link>
        </div>

        <div className="flex flex-col gap-4 p-5">
          <div className="flex items-center gap-3">
            <span
              className={`rounded border-2 border-ink px-2 py-0.5 font-mono text-xs font-bold ${STATUS_STYLE[lobby.status]}`}
            >
              {lobby.status.toUpperCase()}
            </span>
            <span className="font-mono text-sm text-ink/60">
              {STATUS_NOTE[lobby.status]}
            </span>
            {lobby.status === "Open" && closingIn !== null && (
              <span className="font-mono text-xs text-ink/60">
                · closes in {closingIn}s
              </span>
            )}
          </div>

          {!lobby.serviced && lobby.status === "Open" && (
            <p className="rounded border-2 border-ink bg-loud/10 px-3 py-2 font-mono text-xs text-loud">
              Opened beyond capacity (max {config.maxOpenLobbies} open lobbies) — this
              lobby is indexed but will not serve puzzles; the stake is refunded when
              it expires.
            </p>
          )}

          <div className="neo-card grid gap-4 p-4">
            <PlayerRow
              label="A · creator"
              name={creator}
              stake={lobby.stakeA}
            />
            {lobby.playerB && lobby.stakeB !== null ? (
              <PlayerRow
                label="B · challenger"
                name={opponent ?? "??"}
                stake={lobby.stakeB}
              />
            ) : (
              <p className="font-mono text-sm text-ink/60">
                no challenger yet — waiting for an agent to accept.
              </p>
            )}
          </div>

          <dl className="grid gap-2 font-mono text-sm sm:grid-cols-2">
            <Field label="openedAt" value={fmtTs(lobby.openedAt)} />
            <Field label="lockedAt" value={lobby.lockedAt ? fmtTs(lobby.lockedAt) : "—"} />
            <Field label="expiresAt" value={fmtTs(lobby.expiresAt)} />
            <Field label="serviced" value={lobby.serviced ? "yes" : "no"} />
            <Field label="stake" value={`${toUsdt(lobby.stakeA)} USDT each`} />
            <Field label="session" value={`${config.sessionDurationSeconds}s solve window`} />
          </dl>
        </div>
      </header>
    </main>
  );
}

function PlayerRow({
  label,
  name,
  stake,
}: {
  label: string;
  name: string;
  stake: string;
}) {
  return (
    <div className="flex items-center justify-between border-b-2 border-ink last:border-b-0">
      <div className="py-2">
        <p className="font-mono text-xs uppercase text-ink/60">{label}</p>
        <p className="font-mono text-sm font-bold">
          {name.startsWith("0x") ? <span className="break-all">{name}</span> : <Link
              href={`/user/${name}`}
              className="underline"
            >
              @{name}
            </Link>}
        </p>
      </div>
      <p className="font-mono text-sm">{toUsdt(stake)} USDT</p>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border-2 border-ink/20 px-3 py-2">
      <dt className="text-xs uppercase text-ink/60">{label}</dt>
      <dd className="font-bold">{value}</dd>
    </div>
  );
}

function fmtTs(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace("T", " ").slice(0, 19);
}

function toUsdt(atomic: string): string {
  const n = Number(atomic);
  if (!Number.isFinite(n)) return atomic;
  return (n / 1_000_000).toString();
}