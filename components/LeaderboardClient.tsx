"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

type Row = {
  rank: number;
  username: string;
  address: string;
  netEarned: string;
  tournamentsPlayed: number;
  tournamentsWon: number;
};

type SearchResult = {
  rank: number;
  username: string;
  address: string;
  netEarned: string;
};

const PAGE_SIZE = 20;

export default function LeaderboardClient({
  initialRows,
  initialNextCursor,
}: {
  initialRows: Row[];
  initialNextCursor: string | null;
}) {
  const [rows, setRows] = useState<Row[]>(initialRows);
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const fetchingRef = useRef(false);

  const loadMore = useCallback(async () => {
    if (fetchingRef.current || !nextCursor) return;
    fetchingRef.current = true;
    setLoading(true);
    try {
      const res = await fetch(`/leaderboard?cursor=${encodeURIComponent(nextCursor)}&limit=${PAGE_SIZE}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { items: Row[]; nextCursor: string | null };
      setRows((prev) => [...prev, ...data.items]);
      setNextCursor(data.nextCursor);
      setError(false);
    } catch {
      setError(true);
    } finally {
      fetchingRef.current = false;
      setLoading(false);
    }
  }, [nextCursor]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: "200px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [loadMore]);

  async function onSearch(e: React.FormEvent) {
    e.preventDefault();
    const query = q.trim();
    if (!query) {
      setResults(null);
      return;
    }
    setSearching(true);
    try {
      const res = await fetch(`/leaderboard/search?q=${encodeURIComponent(query)}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { results: SearchResult[] };
      setResults(data.results);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  const matchedUsernames = new Set((results ?? []).map((r) => r.username));

  return (
    <div className="neo-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b-[3px] border-ink bg-loud px-4 py-2">
        <h2 className="font-display text-lg uppercase text-white">Rankings</h2>
        <form onSubmit={onSearch} className="flex items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="search username"
            aria-label="search username"
            className="w-44 border-2 border-ink bg-white px-2 py-1 font-mono text-xs outline-none"
          />
          <button type="submit" className="neo-chip !bg-buzz" disabled={searching}>
            {searching ? "…" : "find"}
          </button>
        </form>
      </div>

      <div className="p-4">
        {results !== null && results.length === 0 && (
          <p className="mb-3 border-2 border-ink bg-white p-2 font-mono text-xs text-loud">
            no matches for “{q.trim()}”
          </p>
        )}
        {results !== null && results.length > 0 && (
          <p className="mb-3 border-2 border-ink bg-white p-2 font-mono text-xs">
            matches for “{q.trim()}” (highlighted below):{" "}
            {results.map((r) => (
              <Link
                key={r.address}
                href={`/user/${r.username}`}
                className="font-bold underline"
              >
                #{r.rank} {r.username}{" "}
              </Link>
            ))}
          </p>
        )}

        {rows.length === 0 && !error && (
          <p className="font-mono text-sm">no players yet — settle a tournament to appear.</p>
        )}
        {error && (
          <p className="font-mono text-sm text-loud">!! failed to load the leaderboard</p>
        )}
        {rows.length > 0 && (
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-ink text-left font-mono text-xs uppercase">
                <th className="px-2 py-1">#</th>
                <th className="px-2 py-1">player</th>
                <th className="px-2 py-1 text-right">net</th>
                <th className="px-2 py-1 text-right">played</th>
                <th className="px-2 py-1 text-right">won</th>
              </tr>
            </thead>
            <tbody className="font-mono text-sm">
              {rows.map((r) => (
                <tr
                  key={r.address}
                  className={
                    matchedUsernames.has(r.username)
                      ? "border-b border-ink bg-sky"
                      : "border-b border-ink/30"
                  }
                >
                  <td className="px-2 py-1 font-bold">{r.rank}</td>
                  <td className="px-2 py-1">
                    <Link href={`/user/${r.username}`} className="font-bold underline">
                      {r.username}
                    </Link>
                  </td>
                  <td className={`px-2 py-1 text-right ${netNum(r.netEarned) < 0 ? "text-loud" : ""}`}>
                    {fmtUsd(r.netEarned)}
                  </td>
                  <td className="px-2 py-1 text-right">{r.tournamentsPlayed}</td>
                  <td className="px-2 py-1 text-right">{r.tournamentsWon}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div ref={sentinelRef} className="flex justify-center py-3 font-mono text-xs">
          {loading && <span>loading more…</span>}
          {!loading && nextCursor && <span className="text-ink/40">scroll for more</span>}
          {!nextCursor && rows.length > 0 && <span className="text-ink/40">— end —</span>}
        </div>
      </div>
    </div>
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
