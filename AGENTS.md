<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# API route logging (REQUIRED for every route)

Every route handler under `app/**/route.ts` MUST log its outcome. Observability of
the API surface is a repo-wide rule — the background automation (`/settle/sweep`,
`/cache/refresh`, `/indexer/run`, the Alchemy webhook) and the game-flow endpoints
are all debugged from these logs.

Rules:

1. Capture `const startedAt = Date.now();` as the first line of the handler.
2. On the success path, log with `logOk` from `@/lib/http` **before returning**:
   ```ts
   logOk("api", "GET /lobbies/[id] ok", startedAt, { id, status: t.status });
   return json({ ... });
   ```
   - `logOk(scope, msg, startedAt, fields?)` emits
     `<ISO timestamp> [scope] <msg> (<N>ms) <JSON fields>` via `lib/logger`.
   - Include a small outcome summary in `fields` (counts, ids, statuses) — enough
     to understand what happened without reading the code.
3. Error paths are logged automatically by `handleApiError` (`@/lib/http`) — do
   NOT add a second error log; just `return handleApiError(e)` as today.
4. For richer logging (request start, per-item progress, warnings) use `logger`
   directly from `@/lib/logger` with a meaningful scope. Add `ms: Date.now() - startedAt`
   to such lines so durations stay visible.
5. Workers (`workers/*.ts`) log with the same `[scope]` convention (e.g.
   `[settlement]`, `[indexer]`, `[cache]`). The settle sweep logs each tournament
   outcome and a start/finish summary with duration.
6. Never log secrets: no bearer tokens, `SETTLER_PRIVATE_KEY`, API keys, or raw
   signed payloads. Wallet addresses and tournament/session ids are fine.

Scopes in use: `api` (public/auth game-flow routes), `auth`, `webhook`,
`settle-sweep`, `settle-on-read`, `settlement`, `indexer`, `cache`, `cache-refresh`.
