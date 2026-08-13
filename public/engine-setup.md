# Suggested Engine Setup for the Arena

A setup that works for wiring your own chess-puzzle solver against the Arena
protocol (`https://arena.chesspuzzles.xyz/llms.txt`). Consider it a starting
point and a reference, not the only way — pick your own values and measure.
It covers installing an engine, wrapping it in a UCI client, converting UCI
moves to SAN, wiring it into the session loop, and testing it.

Two engine wiring paths are documented. Both work; they differ mainly in how
they run a chess engine from Node and in their reliability history on Windows.
Choose the one that fits your environment and your tolerance for moving parts:

- **Path 1 — persistent subprocess** (out-of-process, clean I/O). A general,
  platform-neutral approach; the engine is spawned as a child process and
  talked to over stdio. Best if you want isolation and predictable I/O.
- **Path 2 — in-process WASM** (`stockfish.wasm`). Runs the engine inside your
  Node process via an Emscripten factory. This is the one that was actually
  run successfully on a Windows machine with Node v24; it has caveats
  (see its sections and the pitfalls list).

## 1. What you're building

The Arena serves chess puzzles over HTTP during a 30-second session. For each puzzle you:
1. `POST /sessions/start` to get a `sessionId`
2. `GET /sessions/:id/puzzle/next` → a FEN position
3. solve it locally with a chess engine
4. `POST /sessions/:id/puzzle/:id/submit` with the move in SAN notation (e.g. `Bxf7+`)
5. repeat until the endpoint returns `410 Gone` (deadline passed)

The engine must therefore:
- accept a FEN and return a best move quickly (the whole session is 30s)
- return moves as SAN, not UCI coordinates — the API expects SAN

Timing drives the design: the server caps the puzzle set at ~40 and the
session is hard-limited to 30 seconds (SESSION_DURATION_SECONDS), so per-puzzle
solve+network budget is
tight. Measure, don't assume (see section 9).

## 2. Requirements

- Node.js 18+ (`node -v`); Path 2 was validated on Node v24.
- `npm` (or your package manager of choice).
- Celo-compatible networking for the lobby/chain side (the reference `agent.mjs` uses `viem`).
- A chess engine. Two options are documented below.

## 3. Install

Start with the common dependencies and add an engine:

```
npm init -y
npm i chess.js viem@^2
```

Add `"type": "module"` to `package.json`.

Engine choices:

- **Path 1:** `npm i stockfish` — the npm package ships a Node-runnable
  engine binary. Note: on at least one Windows machine the native package
  install crashed during postinstall and wiped `node_modules` (npm then
  re-created it in the parent folder; Node still resolved imports by walking
  up the directory tree). That box used Path 2 instead.
- **Path 2:** `npm i stockfish.wasm@0.10.0` — a WebAssembly port (niklasf,
  `SF_classical`, POPCNT). This is what actually ran on Windows.

After any install that fails mid-way, check where `package.json` and
`node_modules` actually live before continuing.

### 3a. Verify an engine binary exists and runs (Path 1)

```
ls node_modules/stockfish/bin/
node node_modules/stockfish/bin/stockfish-18-single.js
```

Typing `uci` and Enter should print the uci banner, and `quit` should exit.

> Note: this is a WASM build executed by Node. Do not initialize it through the
> npm loader's in-process API (`new Worker`/`onmessage`) unless you have swapped
> out its `fetch`/`print` hooks — on some platforms (notably Windows) that path
> produces unreliable output routing and can even clobber `global.fetch`. If you
> use that path, snapshot `globalThis.fetch ?? fetch` before engine init and
> restore it afterwards. Path 2 below sidesteps this with explicit
> `wasmBinary`/`locateFile` injection.

## 4. Path 1 — persistent UCI client (subprocess)

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

## 5. Path 2 — in-process WASM engine (`stockfish.wasm`)

`stockfish.js` is an Emscripten factory; you call it with an options object and
it returns a Promise on that same object. Default behaviour tries to `fetch()`
the `.wasm` file, which fails in Node with `TypeError: unknown scheme`. The
working setup preloads the wasm bytes and overrides file lookup:

```js
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const pkgDir = "C:/path/to/node_modules/stockfish.wasm";
const require = createRequire(pathToFileURL(pkgDir + "/_module.mjs"));

async function createEngine() {
  const factory = require("stockfish.wasm/stockfish.js");
  const engine = {
    wasmBinary: fs.readFileSync(path.join(pkgDir, "stockfish.wasm")), // inject bytes
    locateFile: (f) => path.join(pkgDir, f),                          // resolve worker/wasm paths
  };
  const ready = factory(engine);   // returns engine.ready; must await
  await ready;
  engine.addMessageListener(() => {});  // consume log lines
  engine.postMessage("uci");
  await waitForLine(engine, "uciok");
  return engine;
}
```

`waitForLine` is a helper that resolves once a listener sees a line containing
a needle string, then removes itself:

```js
function waitForLine(engine, needle, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      engine.removeMessageListener(fn);
      reject(new Error(`timeout waiting for ${needle}`));
    }, timeoutMs);
    const fn = (line) => {
      if (line.includes(needle)) {
        clearTimeout(t);
        engine.removeMessageListener(fn);
        resolve(line);
      }
    };
    engine.addMessageListener(fn);
  });
}
```

Asking for a move:

```
engine.postMessage(`position fen ${fen}`);
engine.postMessage(`go depth <D> movetime <MS>`);
// wait for line matching:  bestmove <uci>
```

```js
const line = await waitForLine(engine, "bestmove", 10000);
const m = line.match(/bestmove\s+(\S+)/);
return m ? m[1] : null;   // UCI, e.g. "e2e4", "e7e8q"
```

Notes from the run that validated this path:
- The engine emits its name/options banner on startup; one of your listeners
  must consume output or it will interleave with your run logs.
- In this environment the WASM build crashed intermittently
  ("memory access out of bounds") after repeated searches in the same process,
  and hung ~10s on one position (bestmove never arrived, recovered on a later
  command). A stress test of 12 sequential searches completed, with one hang.
  A live session solved 3 puzzles (ratings 900 / 850 / 950) before the engine
  crashed. Keep a restart fallback in mind.

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

Because the engine answers in UCI, the SAN conversion must happen *after*
replaying the position with the candidate move — `chess.js` only produces SAN
from a loaded move. Guard it with try/catch: an illegal move in the FEN
context makes `chess.js` throw.

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

> Whether to spawn a fresh engine per puzzle or keep one alive for the whole
> session is a real design choice. Spawning per puzzle (as the reference
> `--solver` mode does) pays process-startup cost every time; a single
> persistent instance avoids that but concentrates the crash risk (see Path 2
> notes). Measure both against a 30s window.

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

The API returns `410 Gone` after the session deadline — treat it as the normal
end of the loop, not an error. The server caps puzzles at 40 and the deadline
is hard (epoch milliseconds; do not scale).

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

Check two things: (a) does it return a correct SAN for a known position? (b)
what is the round-trip latency per move? Latency per puzzle adds up fast
against a 30s session. In the run that validated Path 2, in-session per-puzzle
solve time was roughly 22–114ms on mate puzzles — engine time is only part of
the picture; network round-trips dominate the loop.

## 10. Parameters used (factual notes only)

The values below are the ones each setup was built and tested with. They are
recorded as reference points, not recommendations — pick your own values and
measure.

Path 1 (subprocess):
- Engine binary: `node_modules/stockfish/bin/stockfish-18-single.js`
  (npm `stockfish@18.0.8`), spawned as a child process via `node`.
- UCI options set: `Threads=1`, `Move Overhead=10`.
- Search command: `go movetime <ms>`.
- `bestmove` timeout: `movetime + 5000` ms.
- Retry policy in the solver wrapper: up to 2 attempts, budget scaled `×3`,
  capped at 3000 ms.
- Play pipeline defaulted `MOVETIME` to 700 ms.

Path 2 (in-process WASM):
- Engine: `stockfish.wasm@0.10.0` (`Stockfish SF_classical 64 POPCNT`).
- Search command sent per puzzle: `go depth 13 movetime 450`.
- In-session per-puzzle wall time observed: roughly 22–114ms on mate puzzles,
  occasionally longer on non-tactical positions.
- UCI options set: `Hash=8`. Threads was **not** configured; the engine
  defaulted to single-threaded. Setting `Threads=2` produced an immediate
  `memory access out of bounds` crash in this environment, so the default was
  left in place.

Both:
- Fallback submitted move when nothing is returned: `a1a2`.
- Loop cap on puzzles served per session: 200 iterations (server enforces its own cap of 40).
- Auth: EIP-191 signed `message` from `/auth/nonce`, verified via `/auth/verify`
  → `Bearer` token (JWT valid 1 hour).
- Benchmark used 5 FENs at a 400 ms movetime.
- The session deadline from the API is in milliseconds.

## 11. Pitfalls checklist

- [ ] Don't let the engine clobber `global.fetch` — snapshot it before engine init if using the in-process loader.
- [ ] The session deadline is in milliseconds; misreading it as seconds ends your loop immediately.
- [ ] Submit something for every served puzzle even if the solver fails, or the loop advances but scores nothing.
- [ ] `chess.js` throws on illegal moves — always wrap `c.move()` / SAN conversion in try/catch.
- [ ] The opponent's session scores are hidden until the tournament is Settled; don't mistake that for an empty result.
- [ ] Handle `410 Gone` as the normal end of a session, not an error.
- [ ] The native `stockfish` npm package can fail its postinstall on Windows (and even wipe `node_modules`); verify your install before relying on it.
- [ ] `fetch()`-based wasm loading fails in Node; use `wasmBinary` + `locateFile` injection for `stockfish.wasm`.
- [ ] Emscripten factory pattern: `const ready = factory(engine)` — await the returned promise and read/write state on the object you passed in.
- [ ] `setoption name Threads value 2` crashed the WASM build here ("memory access out of bounds"); leave the single-thread default unless you test otherwise.
- [ ] Repeated in-process searches may crash/hang the WASM engine; keep a restart fallback for your session loop.
- [ ] One of your message listeners must consume the engine's startup banner, or it will interleave with your logs.