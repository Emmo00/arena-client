# Suggested Engine Setup for the Arena

A setup that works for wiring your own chess-puzzle solver against the Arena
protocol (`https://arena.chesspuzzles.xyz/llms.txt`). Consider it a starting
point and a reference, not the only way — pick your own values and measure.
It covers installing an engine, wrapping it in a UCI client, converting UCI
moves to SAN, wiring it into the session loop, and testing it.

## 1. What you're building

The Arena serves chess puzzles over HTTP during a 10-second session. For each puzzle you:
1. `POST /sessions/start` to get a `sessionId`
2. `GET /sessions/:id/puzzle/next` → a FEN position
3. solve it locally with a chess engine
4. `POST /sessions/:id/puzzle/:id/submit` with the move in SAN notation (e.g. `Bxf7+`)
5. repeat until the endpoint returns `410 Gone` (deadline passed)

The engine must therefore:
- accept a FEN and return a best move quickly (the whole session is 10s)
- return moves as SAN, not UCI coordinates — the API expects SAN

## 2. Requirements

- Node.js 18+ (`node -v`)
- `npm`
- Celo-compatible networking for the lobby/chain side (the reference `agent.mjs` uses `viem`)
- A working chess engine. This setup uses `stockfish` (npm), which ships an engine that runs under plain Node

## 3. Install

```
npm init -y
npm i stockfish chess.js viem@^2
```

Add `"type": "module"` to `package.json`.

## 4. Verify the engine binary exists and runs

The npm `stockfish` package ships a Node-runnable engine:

```
ls node_modules/stockfish/bin/
node node_modules/stockfish/bin/stockfish-18-single.js
```

Typing `uci` and Enter should print the uci banner, and `quit` should exit. If you run it interactively you can sanity-check it before writing code.

> Note: this is a WASM build executed by Node. Do not initialize it through the npm loader's in-process API (`new Worker`/`onmessage`) unless you have swapped out its `fetch`/`print` hooks — on some platforms (notably Windows) that path produces unreliable output routing and can even clobber `global.fetch`. If you use that path, snapshot `globalThis.fetch ?? fetch` before engine init and restore it afterwards.

## 5. Write a persistent UCI client (subprocess)

One process, kept alive for the whole session. I/O is line-based over stdio.

Draft (`uci_client.mjs`):

```js
import { spawn } from "node:child_process";

const ENGINE_PATH = "node_modules/stockfish/bin/stockfish-18-single.js";
// resolve to an absolute path from your project root if you run from elsewhere

export async function createUCI(enginePath = ENGINE_PATH) {
  const p = spawn("node", [enginePath], { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  let want = [];
  p.stdout.setEncoding("utf8");

  const uci = {
    bestmove(fen, movetime) {
      p.stdin.write("ucinewgame\n");
      p.stdin.write(`position fen ${fen}\n`);
      return new Promise((res, rej) => {
        const w = { type: "bestmove", res };
        want.push(w);
        p.stdin.write(`go movetime ${movetime}\n`);
        setTimeout(() => {
          const i = want.indexOf(w);
          if (i >= 0) want.splice(i, 1);
          rej(new Error("uci timeout"));
        }, movetime + 5000);
      });
    },
    stop() { p.kill(); },
  };

  p.stdout.on("data", (d) => {
    buf += d;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) {
      const t = l.trim();
      if (!t) continue;
      for (let i = want.length - 1; i >= 0; i--) {
        const w = want[i];
        if (w.type === "readyok" && t === "readyok") { want.splice(i, 1); w.res(); }
        else if (w.type === "bestmove" && t.startsWith("bestmove")) { want.splice(i, 1); w.res(t); }
      }
    }
  });
  p.stderr.on("data", () => {});

  p.stdin.write("uci\n");
  p.stdin.write("setoption name Threads value 1\n");
  p.stdin.write("setoption name Move Overhead value 10\n");

  await new Promise((res) => {
    const w = { type: "readyok", res };
    want.push(w);
    p.stdin.write("isready\n");
    setTimeout(() => { const i = want.indexOf(w); if (i >= 0) want.splice(i, 1); res(); }, 3000);
  });

  return uci;
}
```

Design notes:
- **Serialization:** one pending `bestmove` at a time; commands are written in order and the response matcher scans for the corresponding output line.
- **Timeout safety:** every pending request has a hard timeout so a hung engine can't stall the session loop.
- **Readiness:** UCI engines signal `readyok` after `isready`; wait once during init, not on every move (a per-move `isready` roundtrip can race with `bestmove` output).

## 6. Convert UCI moves to SAN

The engine returns `bestmove a2a3` (coordinates, optionally `e7e8q` for promotion). The API wants SAN. `chess.js` converts for you:

```js
import { Chess } from "chess.js";

function sanOf(fen, uciMove) {
  try {
    const c = new Chess(fen);
    const m = c.move({
      from: uciMove.slice(0, 2),
      to: uciMove.slice(2, 4),
      promotion: uciMove.length > 4 ? uciMove[4] : undefined,
    });
    return m ? m.san : undefined;
  } catch {
    return undefined;
  }
}
```

Guard it with try/catch — an illegal move in the FEN context makes `chess.js` throw.

## 7. Solve wrapper with fallback

Wrap `bestmove` so a bad/no result doesn't kill your loop:

```js
async function solveMove(uci, fen, movetime) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const line = await uci.bestmove(fen, movetime);
      const m = /^bestmove\s+(\S+)/.exec(line.trim());
      if (m && m[1] && m[1] !== "(none)") {
        const san = sanOf(fen, m[1]);
        if (san) return san;
      }
    } catch {
      /* retry with a larger budget */
    }
    movetime = Math.min(movetime * 3, 3000);
  }
  return undefined; // caller decides what to submit
}
```

If `solveMove` returns `undefined`, still submit something so the loop advances (the reference agent uses `"a1a2"` for this).

## 8. Wire it into the session loop

Minimal loop (auth flow omitted — see `llms.txt` / reference `agent.mjs`):

```js
// token = await signIn(...); sessionId = await start(...)
for (let i = 0; i < 200; i++) {
  let next;
  try {
    next = await api(`/sessions/${sessionId}/puzzle/next`, { token });
  } catch (e) {
    if (e.status === 410) break; // deadline passed
    throw e;
  }
  if (next.done || !next.puzzleId) break;
  const move = (await solveMove(uci, next.fen ?? "", MOVETIME)) ?? "a1a2";
  let sub;
  try {
    sub = await api(`/sessions/${sessionId}/puzzle/${next.puzzleId}/submit`,
      { method: "POST", token, body: { move } });
  } catch (e) {
    if (e.status === 410) break;
    throw e;
  }
  if (sub.correct) { /* track solved++, ratingSum += sub.ratingAwarded */ }
}
```

The API returns `410 Gone` after the session deadline — treat it as the loop terminator. The server caps puzzles at 40 and the deadline is hard.

## 9. Test before going live

Bench your solver on fixed FENs independently of the Arena (draft `bench.mjs`):

```js
import { Chess } from "chess.js";
import { createUCI } from "./uci_client.mjs";
const uci = await createUCI();
const puzzles = [ /* 5–10 FEN strings you trust answers for */ ];
for (const fen of puzzles) {
  const t0 = Date.now();
  const san = await solveMove(uci, fen, 400);
  console.log(JSON.stringify({ ok: !!san, san, ms: Date.now() - t0, fen }));
}
uci.stop();
process.exit(0);
```

Check two things: (a) does it return a correct SAN for a known position? (b) what is the round-trip latency per move? Latency per puzzle adds up fast against a 10s session, so measure it.

## 10. Parameters used in this setup (factual notes only)

The values below are the ones this setup was built and tested with. They are recorded here as a reference point, not as a recommendation — pick your own values and measure.

- Engine binary: `node_modules/stockfish/bin/stockfish-18-single.js` (the npm `stockfish@18.0.8` package), spawned as a child process via `node`.
- UCI options set: `Threads=1`, `Move Overhead=10`.
- Search command: `go movetime <ms>`.
- `bestmove` timeout: `movetime + 5000` ms.
- Retry policy in the solver wrapper: up to 2 attempts, budget scaled `×3`, capped at 3000 ms.
- Fallback submitted move when nothing is returned: `a1a2`.
- Loop cap on puzzles served per session: 200 iterations (server enforces its own cap of 40).
- Auth: EIP-191 signed `message` from `/auth/nonce`, verified via `/auth/verify` → `Bearer` token (JWT valid 1 hour).
- Bench test used 5 FENs at a 400 ms movetime; the play pipeline defaulted `MOVETIME` to 700 ms.
- The session deadline from the API is in milliseconds.

## 11. Pitfalls checklist

- [ ] Don't let the engine clobber `global.fetch` — snapshot it before engine init if using the in-process loader.
- [ ] The session deadline is in milliseconds; misreading it as seconds ends your loop immediately.
- [ ] Submit something for every served puzzle even if the solver fails, or the loop still advances but scores nothing.
- [ ] `chess.js` throws on illegal moves — always wrap `c.move()` in try/catch.
- [ ] The opponent's session scores are hidden until the tournament is Settled; don't mistake that for an empty result.
- [ ] Handle `410 Gone` as the normal end of a session, not an error.