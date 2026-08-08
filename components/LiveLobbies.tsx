"use client";

import { useEffect, useState } from "react";

type Lobby = {
  id: number;
  stake: string;
  openedAt: number;
  expiresAt: number;
};

export default function LiveLobbies() {
  const [lobbies, setLobbies] = useState<Lobby[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState(false);

  useEffect(() => {
    let stopped = false;
    const tick = () => {
      setNow(Date.now());
    };
    const poll = async () => {
      try {
        const res = await fetch("/lobbies/open", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          if (!stopped) {
            setLobbies((data.lobbies ?? []) as Lobby[]);
            setError(false);
          }
        } else {
          setError(true);
        }
      } catch {
        setError(true);
      }
    };
    tick();
    poll();
    const t = setInterval(() => {
      tick();
      poll();
    }, 5000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="neo-card">
      <div className="flex items-center justify-between border-b-[3px] border-ink bg-loud px-4 py-2">
        <h2 className="font-display text-lg uppercase text-white">Live open lobbies</h2>
        <span className="font-mono text-xs font-bold text-white">POLL /lobbies/open · 5s</span>
      </div>
      <div className="p-4">
        {error && (
          <p className="font-mono text-sm text-loud">
            !! cannot reach /lobbies/open (is the API up?)
          </p>
        )}
        {!error && lobbies.length === 0 && (
          <p className="font-mono text-sm">no open lobbies right now.</p>
        )}
        {lobbies.length > 0 && (
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-ink text-left font-mono text-xs uppercase">
                <th className="px-2 py-1">id</th>
                <th className="px-2 py-1">stake</th>
                <th className="px-2 py-1">opened</th>
                <th className="px-2 py-1">expires</th>
              </tr>
            </thead>
            <tbody className="font-mono text-sm">
              {lobbies.map((l) => (
                <tr key={l.id} className="border-b border-ink/30">
                  <td className="px-2 py-1 font-bold">#{l.id}</td>
                  <td className="px-2 py-1">{formatStake(l.stake)} USDT</td>
                  <td className="px-2 py-1">{ago(l.openedAt, now)}</td>
                  <td className="px-2 py-1">
                    in {Math.max(0, l.expiresAt - Math.floor(now / 1000))}s
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function formatStake(atomic: string): string {
  const n = Number(atomic);
  if (!Number.isFinite(n)) return atomic;
  return (n / 1_000_000).toString();
}

function ago(epochSeconds: number, now: number): string {
  const s = Math.floor(now / 1000) - epochSeconds;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
