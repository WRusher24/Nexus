# Project Status

## Current milestone: 9 (Frontend, hardening, and production readiness)

## Last session: 2026-10-08

## State: Deployable product. React Flow + ELK frontend (search → disambiguation → interactive causal graph with audit-brief nodes, side panel, evidence cards, feedback), production hardening (admin audit/cost/kill-switch endpoints, Vercel cron, Playwright smoke test), and a deployment runbook. `pnpm run verify` green (499 tests, 53 files); invariant audit 14/14; `pnpm run build` succeeds with all 18 routes registered.

## Next: v2 backlog — dark mode, mobile layout, graph export, Redis rate limiting, LISTEN/NOTIFY SSE, automated Playwright.

---

## Session log — 2026-10-08 (Milestone 9)

### Frontend stack

- **Graph:** `@xyflow/react` v12.12.0 (React Flow) with custom `history` node
  and edge components.
- **Layout:** `elkjs` 0.12.0 (bundled build, runs in the browser), layered
  algorithm, `RIGHT` direction (causes left, effects right), `POLYLINE` routing.
  Re-laid out on node/edge-set change and via the Re-layout control, not on drag.
- **State:** `zustand` 5.0.15 — one store for nodes/edges/selection/expansion
  states/quota; React Flow's controlled arrays are derived from it.
- **Styling:** `tailwindcss` v4.3.3 via `@tailwindcss/postcss` (PostCSS plugin)
  + `autoprefixer`. `tailwind.config.ts` uses the v4 `@config` directive from
  `globals.css` (`@import "tailwindcss"; @config "../../tailwind.config.ts";`).
  Light mode only.
- **Testing:** `@playwright/test` (already present).

### Files added / changed (all NEW unless noted)

Frontend:

- `src/app/layout.tsx` — UPDATE: metadata, global CSS, `SessionProvider`.
- `src/app/globals.css` — UPDATE: Tailwind v4 import + config.
- `src/app/page.tsx` — FULL REWRITE: auth/search/graph state machine + the
  expansion flow (endpoint + SSE) registered on the store.
- `src/components/search/SearchBar.tsx`, `CandidateList.tsx`.
- `src/components/graph/GraphCanvas.tsx`, `HistoryNode.tsx`, `HistoryEdge.tsx`,
  `GraphControls.tsx`, `NodeStateBadge.tsx`.
- `src/components/panel/SidePanel.tsx`, `EvidenceCard.tsx`,
  `FeedbackButtons.tsx`, `QuotaDisplay.tsx`.
- `src/components/auth/SignInButton.tsx`, `SessionProvider.tsx`.
- `src/lib/frontend/api.ts`, `sse.ts`, `store.ts`, `layout.ts`, `types.ts`.

Hardening:

- `src/app/api/admin/audit/route.ts`, `cost/route.ts`, `kill-switch/route.ts`.
- `src/lib/hardening/auditScheduler.ts`, `costReport.ts`.
- `src/app/api/edges/[id]/route.ts` — NEW (single edge + evidence spans).
- `src/app/api/auth/test-login/route.ts` — NEW (test-only session bootstrap).
- `src/lib/db/audit.ts` — refactored to export `runInvariantAudit` +
  `createDbAuditRunner` so the admin route runs the audits in-process. CLI
  behavior (output + exit code) is unchanged; `main()` now runs only when the
  module is executed directly.

Testing / config:

- `playwright.config.ts`, `e2e/smoke.spec.ts`, `e2e/fixtures/global-setup.ts`.
- `tailwind.config.ts`, `postcss.config.js`, `vercel.json`.
- `docker-compose.yml` — EXTEND: `worker` service.
- `.env.example` — documents `ADMIN_EMAILS`, `CRON_SECRET`.
- `package.json` — `e2e` / `e2e:install` scripts; deps below.
- `docs/DEPLOY.md` — NEW runbook.
- `docs/STATUS.md` — this update.

### Dependencies added (each justified)

| Package | Version | Justification |
| --- | --- | --- |
| `@xyflow/react` | ^12.12.0 | Specified frontend graph library. |
| `elkjs` | ^0.12.0 | Deterministic layered layout for DAGs (blueprint). |
| `zustand` | ^5.0.15 | Minimal global graph/viewport state; avoids context re-render storms. |
| `tailwindcss` | ^4.3.3 | Utility-first styling (standard Next.js approach). |
| `@tailwindcss/postcss` | ^4.3.3 | Tailwind v4 PostCSS plugin. |
| `autoprefixer` | ^10.6.1 | Explicit vendor prefixing. |
| `@playwright/test` | ^1.63.0 | Already present from M1; used for the smoke test. |

No other dependencies were added.

### ELK configuration

```ts
'elk.algorithm': 'layered',
'elk.direction': 'RIGHT',
'elk.layered.spacing.nodeNodeBetweenLayers': '80',
'elk.spacing.nodeNode': '30',
'elk.edgeRouting': 'POLYLINE',
'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
```

### Deployment architecture

- **Web:** Vercel (Next.js App Router). `/` is a static client shell; the API
  routes are dynamic Node.js functions.
- **Worker:** long-lived container (Railway/Render/Fly/VPS), `pnpm run worker`;
  cannot run on Vercel serverless.
- **Database:** Neon PostgreSQL 16, pooled `DATABASE_URL` for the app/worker,
  direct `DIRECT_URL` for migrations.
- **Cron:** Vercel Cron → `GET /api/admin/audit` every 6h with `CRON_SECRET`.
- Full details in `docs/DEPLOY.md`.

### Verification (this session)

- `pnpm run typecheck` — PASS.
- `pnpm run lint` — PASS (0 errors, 41 non-null-assertion warnings, all in
  pre-existing tests).
- `pnpm run test` — 499/499 PASS (53 files) — unchanged.
- `pnpm run audit:invariants` — 14/14 PASS.
- `pnpm run build` — PASS; 18 routes registered (3 admin, 1 test-login, 1 edge
  detail + the 13 M8 routes and the pages).
- Live manual journey (browser) — PASS: magic-link sign-in → live Wikipedia
  search (Q8736) → root node → ELK graph (root at x=345, 10 causes at x=12) →
  upstream expansion completed in ~30s (11 nodes, 10 edges, badge EXPANDED) →
  node panel (connections) → edge panel with a verified evidence quote pinned
  to revision 1378834026 → feedback persisted. No browser console errors.
- Playwright smoke test — PASS (`pnpm exec playwright install chromium` then
  `pnpm run e2e`: 1 passed in 30.8s).

### Known limitations (v1)

- **No dark mode** (light mode only) and **no mobile-responsive layout**.
- **No collaborative editing**, public graph sharing, or undo/redo.
- **ELK layout** uses a fixed 220×130 node box estimate; very tall cards can
  slightly overlap vertically until re-layout.
- **React Flow bundle** is large (~496 kB for `/`); a Web Worker layout + code
  splitting is a v2 optimisation.
- **👍 feedback** is local-only: the M8 feedback enum has no positive type, so
  only 👎 (INCORRECT) is persisted. Adding a `CORRECT` type needs a migration.
- **Playwright smoke test** is manual (live Wikipedia + LLM); it is idempotent
  on re-runs (if the root is already expanded the expand click is skipped).

### Deviations / decisions (with reasons)

1. **`src/lib/db/audit.ts` refactored** (not in the allowed-file list). The task
   requires `/api/admin/audit` to run the audits *programmatically*; the module
   previously ran as an unconditional CLI. Exported `runInvariantAudit` +
   `AuditQueryRunner` and guarded `main()` behind a direct-invocation check.
   CLI output/exit code are byte-identical.
2. **`/api/edges/[id]` and `/api/auth/test-login` are additive routes.** The
   task explicitly calls for both (Parts 4.2 and 7.1). Neither modifies an M8
   route. `test-login` returns 404 unless `NODE_ENV=test` **or
   `E2E_TEST_AUTH=1`**; the flag is needed because Next.js ignores `.env.local`
   when `NODE_ENV=test`, which would drop `DATABASE_URL` for the dev server and
   the worker.
3. **Tailwind v4, not v3.** The brief allowed the builder's call and listed
   `@tailwindcss/postcss`, so v4 was used with `@import "tailwindcss"` and the
   `@config` directive instead of the v3 `@tailwind base/components/utilities`
   directives.
4. **`.env.example` updated** (outside the listed files) to document
   `ADMIN_EMAILS` and `CRON_SECRET`, which the new admin routes read. This
   mirrors the M8 precedent.
5. **SSE reconnection is client-managed.** `EventSource` auto-reconnects; the
   client closes and reconnects explicitly so attempts are bounded
   (`maxReconnects = 5`) and `timeout` is distinguished from `close`.
6. **Playwright starts only the web server in `webServer`; the worker is spawned
   by `globalSetup`.** Playwright's `webServer` health check needs a URL/port and
   the worker opens neither. `E2E_SKIP_WORKER=1` opts out.
7. **Feedback mapping.** 👍 is local-only, 👎 persists `INCORRECT` (see Known
   limitations) because the M8 enum has no positive value and M8 routes must not
   be modified.

### Environment

- Verified locally against PostgreSQL 18, database `nexus_test`.
- No new Vitest tests were required (the brief scopes frontend verification to
  Playwright + the existing 499 suite), so the suite count is unchanged.

---

## Session log — 2026-10-08 (Milestone 8)

Completed (all NEW unless noted):

- `src/lib/auth/allowlist.ts` — invite-only email allowlist
  (`ALLOWED_EMAILS`, case-insensitive + trimmed, fail-closed in production,
  dev-open when unset).
- `src/lib/auth/emailProvider.ts` — hand-built Auth.js email provider with a
  **console transport** (logs `[AUTH] Magic link for <email>: <url>`), avoiding
  the `nodemailer` runtime dependency.
- `src/lib/auth/config.ts` — `NextAuth({ adapter: DrizzleAdapter(...),
  session: { strategy: 'database' }, providers: [email] })` with a `signIn`
  allowlist gate and a `session` callback that stamps `session.user.id`.
- `src/lib/auth/session.ts` — `requireUser` / `getOptionalUserId` with a
  test-only session override.
- `src/lib/http/responses.ts`, `errors.ts`, `validation.ts`, `rateLimit.ts`,
  `db.ts`, `testOverrides.ts` — typed JSON responses, typed error bodies with
  status mapping, Zod body/query parsing, an in-memory token-bucket limiter
  (search 20/min, expansion 10/min, default 60/min), a lazy DB accessor, and
  test-only override slots (route modules may not export test hooks; Next
  validates route exports at build time).
- `src/lib/sse/stream.ts` — `createSseStream` (status-on-change, keepalive
  comments, hard timeout, terminal close, abort cleanup) + `formatSseEvent`.
- `src/lib/sse/pollExpansion.ts` — `fetchExpansionStatus` (request + node
  state) and `isTerminalStatus`.
- `src/lib/feedback/autoHide.ts` — `checkAutoHide`: `>= 2` distinct INCORRECT
  reporters → `UPDATE edges SET status = 'SUPERSEDED'`.
- `src/app/api/**/route.ts` — search, root-nodes, nodes (+ancestors /
  descendants), expansions (POST / GET / SSE stream), edge feedback, quota, and
  the Auth.js catch-all handler. Every route sets `runtime = 'nodejs'`; the SSE
  route also sets `maxDuration = 120`.
- `src/lib/db/schema.ts` — EXTENDED with Auth.js `users`, `accounts`,
  `sessions`, `verificationTokens`; `userQuotas.userId` /
  `edgeFeedback.userId` now FK to `users` (CASCADE) and
  `expansionRequests.requestedBy` is now nullable with FK `ON DELETE SET NULL`.
- `src/lib/db/migrations/0001_ordinary_cloak.sql` — NEW: auth tables, a
  backfill of placeholder users for every existing userId reference, the FKs,
  and a `provision_referenced_user()` bridge trigger (see Deviations).
- `src/lib/db/audit.ts` — EXTENDED with audits 13 (feedback auto-hide gating)
  and 14 (orphaned user references). 14/14.
- `scripts/check-state-writes.mjs` — EXTENDED with `edges.status` checks; the
  allowlist now includes `src/lib/feedback/autoHide.ts` (and the two existing
  edges.status writers, `insertVerifiedEdge.ts` / `mergeNodes.ts`).
- `src/test/helpers/apiClient.ts` — direct route invoker (no HTTP server) with
  dynamic-segment parsing and a `insertTestUser` helper.
- `src/test/helpers/authSession.ts` — `setTestSession` / `clearTestSession`.
- `.env.example` — documented `ALLOWED_EMAILS`, `EMAIL_PROVIDER`,
  `EMAIL_FROM`, `EMAIL_API_KEY`.
- `package.json` — added `@auth/drizzle-adapter@1.11.3` only
  (`next-auth@5.0.0-beta.32` was already present).

Tests added (59; 440 + 59 = 499 total, 53 files):

- `src/test/integration/auth/allowlist.test.ts` (7).
- `src/test/integration/auth/session.test.ts` (5).
- `src/test/integration/api/search.test.ts` (6).
- `src/test/integration/api/rootNodes.test.ts` (5).
- `src/test/integration/api/nodes.test.ts` (6).
- `src/test/integration/api/expansions.test.ts` (10).
- `src/test/integration/sse/stream.test.ts` (8).
- `src/test/integration/api/feedback.test.ts` (6).
- `src/test/integration/api/quota.test.ts` (4).
- `src/test/integration/api/endToEnd.test.ts` (2).

`pnpm run verify` output: lint PASS (0 errors, 41 non-null-assertion warnings,
all in tests), state-writes PASS, typecheck PASS, 499/499 tests PASS (53 files),
audit 14/14 PASS. `next build` also PASSES (all 12 API routes registered).

`pnpm run audit:invariants` output:

```
Nexus Invariant Audit
=====================
[PASS] Audit 1 (P1): No identity-less nodes (0 violations)
[PASS] Audit 2 (P1): No duplicate QIDs (0 violations)
[PASS] Audit 3 (P2): No self-referential edges (0 violations)
[PASS] Audit 4 (P2): No cycles in the active edge graph (0 violations)
[PASS] Audit 5 (P3): No active edges without verified evidence (0 violations)
[PASS] Audit 6 (P2): No active edges with out-of-bounds importance rank (0 violations)
[PASS] Audit 7 (P1): No duplicate active edges (0 violations)
[PASS] Audit 8 (Queue): No in-flight expansion requests without a node (0 violations)
[PASS] Audit 9 (Queue): No LOADING nodes without an in-flight request (0 violations)
[PASS] Audit 10 (Queue): No leases stale for more than 5 minutes (0 violations)
[PASS] Audit 11 (P6): No users over their monthly expansion limit (0 violations)
[PASS] Audit 12 (P6): No global budget overrun (0 violations)
[PASS] Audit 13 (Feedback): SUPERSEDED edges have >= 2 distinct INCORRECT reporters (0 violations)
[PASS] Audit 14 (Users): All userId references resolve to a users row (0 violations)
=====================
Result: 14/14 passed
```

### Auth.js email provider decision

M8 ships the **console transport** (`EMAIL_PROVIDER=console`, the default): the
magic link is logged to stdout as `[AUTH] Magic link for <email>: <url>`.
No external email service is configured and **no `nodemailer` dependency was
added** (the provider object is constructed by hand rather than via
`next-auth/providers/nodemailer`, which requires nodemailer at runtime). To move
to production, implement `sendVerificationRequest` in
`src/lib/auth/emailProvider.ts` for the chosen service (Resend / Postmark / SES)
and set `EMAIL_PROVIDER`, `EMAIL_FROM`, and `EMAIL_API_KEY`. The rest of the
config is unchanged. Resend/Postmark/SES currently fall back to the console
transport with a startup warning rather than failing sign-in.

### SSE deployment note (Vercel vs. container)

`/api/expansions/[id]/stream` polls Postgres every **2 seconds**, sends
`: keepalive` every **15 seconds**, and enforces a hard **120-second** timeout
(emits `event: timeout` then closes; the client reconnects and resumes from the
next `status` event). The route declares `export const runtime = 'nodejs'` and
`export const maxDuration = 120`.

- **Container host** (Railway/Render/Fly/VPS): no function-duration limit; SSE
  works as specified.
- **Vercel**: requires at least the Pro plan for a 120s function budget; Hobby
  caps functions far below that. If a long extraction outlives the function, the
  client reconnects. A documented fallback is to poll `/api/expansions/{id}`
  every 2 seconds instead of streaming.
- There is **no push from the worker**: the stream polls the DB. Postgres
  `LISTEN/NOTIFY` is a v2 optimisation.

### edges table write paths (state-write enforcement)

There are now **three** sanctioned writers of `edges.status`, all allowlisted in
`scripts/check-state-writes.mjs`:

1. `insertVerifiedEdge.ts` — writes `ACTIVE` on insert.
2. `mergeNodes.ts` (M4) — retires duplicate `ACTIVE` edges to `SUPERSEDED`.
3. `feedback/autoHide.ts` (M8) — feedback-driven `ACTIVE → SUPERSEDED`.

The brief described auto-hide as the "second" writer; the merge path is the
actual third. The enforcement script was extended with `edges.status` checks and
verified to still fail for writes outside the allowlist.

### Migration evidence

- **Fresh database** (`nexus_m8_fresh`, empty): `pnpm run db:migrate` applied
  0000 + 0001 cleanly; 15 tables and 4 triggers present
  (`trg_edge_evidence`, `trg_provision_user_{userquotas,expansionrequests,edgefeedback}`).
- **Existing M7 data** (`nexus_test` with seed rows): applied cleanly; the
  backfill created users for `legacy-user-1` / `legacy-user-2` before the FKs
  were validated. Verified that a brand-new `expansionRequests.requestedBy`
  auto-provisions a user, and that deleting a user sets `requestedBy` to NULL.

### Deviations / decisions (with reasons)

1. **`provision_referenced_user` bridge trigger.** The M2–M7 test fixtures and
   the queue's public API use arbitrary string user ids (e.g. `user-1`) that
   predate the users table. Adding enforcing FKs would have failed ~hundreds of
   prior tests. The migration backfills placeholder users for existing rows and
   a `BEFORE INSERT` trigger auto-provisions a placeholder user (id = the
   referenced string) for any future unknown reference, keeping the FK valid and
   idempotent. Production always passes an authenticated `users.id`; the trigger
   only bridges legacy/test references. Documented in the migration.
2. **Test hooks live in `src/lib/http/testOverrides.ts`, not on route modules.**
   Next.js rejects non-handler exports in `route.ts` at build time. This was
   discovered by `next build` and fixed; the API tests import the setters from
   the overrides module.
3. **`src/test/helpers/db.ts` and `.eslintrc`-adjacent files changed outside the
   brief's list.** `db.ts`'s `resetTestDb` gained the four auth tables so each
   test starts clean. `.env.example` documents the new auth env vars. Both are
   necessary consequences of the auth tables.
4. **`logs`/email provider and `@auth/drizzle-adapter`.** The adapter was the
   only new dependency. `next-auth@5.0.0-beta.32` was already in
   `package.json`.
5. **`expansionRequests.requestedBy` made nullable.** Required for the brief's
   `ON DELETE SET NULL` to mean anything (history survives user deletion). No
   production inserts a NULL; the queue always supplies the session id.
6. **Non-null assertions in tests.** 22 new warnings; the repo already tolerates
   `no-non-null-assertion` warnings (M6/M7 had 19). No rule was weakened.
7. **Audit 13 gates on "has >= 1 INCORRECT feedback".** Edges SUPERSEDED by the
   M4 merge path carry no feedback and must not be flagged; only feedback-bearing
   SUPERSEDED edges are checked for the `>= 2` rule.

### Environment

- Verified locally against PostgreSQL 18, database `nexus_test`.
- All M8 tests use the M6 fixture provider and M5 fixture-backed
  Wikipedia/Wikidata clients; no live LLM or Wikipedia calls.
- Dev smoke test: `GET http://localhost:3000/api/search?q=test` →
  `401 {"error":"UNAUTHORIZED","message":"Authentication required"}`.

---

## Session log — 2026-10-08 (Milestone 7)

Completed (all NEW unless noted):

- `src/lib/queue/types.ts` — shared status unions (`ExpansionRequestStatus`,
  `NodeExpansionState`), `IN_FLIGHT_STATUSES`, and the public
  `requestExpansion` input/result types.
- `src/lib/queue/errors.ts` — `QueueError` + `isUniqueViolation` (SQLSTATE
  23505 unwrapped through Drizzle's cause chain).
- `src/lib/queue/transition.ts` — **the single state-machine writer**.
  `transition()` updates `expansionRequests.status` and the node's
  `upstreamState`/`downstreamState` in one transaction with an optimistic
  `WHERE status = $fromStatus` lock; `setNodeState()` is the shared node-state
  helper. Exports `REQUEST_TO_NODE_STATE` and `LEGAL_TRANSITIONS`.
- `src/lib/queue/depth.ts` — `checkDepth` wrapping `distanceToNearestRoot`
  (A10); `MAX_DEPTH_FROM_ROOT = 6`, orphan sentinel `999`.
- `src/lib/queue/quota.ts` — `ensureUserQuota`, `reserveUserQuota` (day/month
  rollover + single conditional UPDATE), `refundUserQuota`, `getUserQuota`.
- `src/lib/queue/requestExpansion.ts` — the public API: CACHE_HIT / IN_PROGRESS
  / QUEUED / REJECTED, with quota reserved only for fresh work and refunded on
  a losing insert race.
- `src/lib/queue/claim.ts` — `SELECT ... FOR UPDATE SKIP LOCKED` claim; the
  **only** place `attempt` is incremented; also flips the node to LOADING.
- `src/lib/queue/heartbeat.ts` — `setInterval` lease extension scoped to
  `lockedBy`; stops on a lost lease, tolerates transient DB errors.
- `src/lib/queue/reaper.ts` — releases stale leases via `transition` (never
  increments `attempt`); `BACKOFF_SECONDS` (30/120/0) and `MAX_ATTEMPTS = 3`.
- `src/lib/queue/processExpansion.ts` — wraps `runExtraction` with Option A
  phase transitions, quota refunds, retry scheduling, and heartbeat lifecycle;
  `releaseLeaseAfterError` is the crash-release helper.
- `src/lib/queue/index.ts` — barrel.
- `src/worker/runLoop.ts` — serial claim/process loop + reaper interval,
  abortable sleep, onIdle/onProcessed/onError hooks.
- `src/worker/graceful.ts` — SIGINT/SIGTERM → AbortController; second signal
  forces exit(130).
- `src/worker/index.ts` — FULL REWRITE of the M1 placeholder: builds the real
  provider + Wikipedia/Wikidata clients + source-document service, registers
  signals, runs the loop.
- `src/lib/db/audit.ts` — EXTENDED with 5 queue/P6 audits (8–12).
- `scripts/check-state-writes.mjs` — grep enforcement (see Deviations).
- `src/test/helpers/workerHarness.ts`, `src/test/integration/queue/*` (7 files),
  `src/test/integration/worker/*` (2 files) — see test totals below.

Tests added (82; 358 + 82 = 440 total, 43 files):

- `src/test/integration/queue/transition.test.ts` (12).
- `src/test/integration/queue/requestExpansion.test.ts` (15).
- `src/test/integration/queue/claim.test.ts` (8).
- `src/test/integration/queue/heartbeat.test.ts` (5).
- `src/test/integration/queue/reaper.test.ts` (8).
- `src/test/integration/queue/quota.test.ts` (9).
- `src/test/integration/queue/depth.test.ts` (6).
- `src/test/integration/queue/processExpansion.test.ts` (10).
- `src/test/integration/worker/runLoop.test.ts` (6).
- `src/test/integration/worker/endToEnd.test.ts` (3).

`pnpm run verify` output: lint PASS (0 errors, 19 non-null-assertion warnings),
state-writes PASS, typecheck PASS, 440/440 tests PASS (43 files), audit 12/12
PASS.

`pnpm run audit:invariants` output:

```
Nexus Invariant Audit
=====================
[PASS] Audit 1 (P1): No identity-less nodes (0 violations)
[PASS] Audit 2 (P1): No duplicate QIDs (0 violations)
[PASS] Audit 3 (P2): No self-referential edges (0 violations)
[PASS] Audit 4 (P2): No cycles in the active edge graph (0 violations)
[PASS] Audit 5 (P3): No active edges without verified evidence (0 violations)
[PASS] Audit 6 (P2): No active edges with out-of-bounds importance rank (0 violations)
[PASS] Audit 7 (P1): No duplicate active edges (0 violations)
[PASS] Audit 8 (Queue): No in-flight expansion requests without a node (0 violations)
[PASS] Audit 9 (Queue): No LOADING nodes without an in-flight request (0 violations)
[PASS] Audit 10 (Queue): No leases stale for more than 5 minutes (0 violations)
[PASS] Audit 11 (P6): No users over their monthly expansion limit (0 violations)
[PASS] Audit 12 (P6): No global budget overrun (0 violations)
=====================
Result: 12/12 passed
```

### Phase transition decision — Option A

`processExpansion` uses **Option A** (recommended in the brief): the
orchestrator's internal phases (fetch/chunk/validate) are NOT surfaced. One
transition enters `EXTRACTING` for the whole `runExtraction` call and one leaves
it on success/retry/failure. `FETCHING` and `VALIDATING` remain in the enum and
in `LEGAL_TRANSITIONS` for the Option B refinement. To support Option A,
`LEGAL_TRANSITIONS.LOCKED` also allows `EXTRACTING` (see Deviations).

### Backoff schedule

The attempt counter is incremented **only** by `claim.ts`. The reaper and
`processExpansion` never touch it (Amendment A8). The schedule is:

| Attempt consumed | On retryable failure | Backoff |
| --- | --- | --- |
| 1 | `PENDING` with `retryAfter = now + 30s` | 30s |
| 2 | `PENDING` with `retryAfter = now + 120s` | 120s |
| 3 (`MAX_ATTEMPTS`) | `FAILED` (no further retry) | — |

The reaper uses the same table when it releases an expired lease.

### Quota vs. budget refund asymmetry

Quota is refunded on `ABORTED_BUDGET` and `ABORTED_NO_SOURCE` (no LLM call was
made) but **not** on an LLM failure (real work was attempted). Budget refunds on
LLM failure are handled by M6's `reconcileBudget`.

### Worker deployment notes

- The worker is a long-lived process and **cannot run on Vercel serverless**
  (function timeout). Run it in a container (Railway/Render/Fly/VPS) with
  `pnpm run worker`.
- One worker processes requests serially. Scale horizontally by running N
  containers; `SKIP LOCKED` keeps them from colliding.
- Set `WORKER_ID` per container for readable lease ownership; defaults to
  `worker-<pid>-<timestamp>`.
- Requires `DATABASE_URL`, `WIKIPEDIA_CONTACT_EMAIL`, and the provider API key
  selected by `EXTRACTION_PROVIDER`.
- A SIGKILL/OOM leaves the lease in the DB; the reaper (a sibling worker, or
  this worker on restart) returns it to `PENDING`.

### M8 handoff

M8 can call `requestExpansion(db, { nodeId, direction, userId })` directly from
its HTTP handler and branch on `CACHE_HIT | IN_PROGRESS | QUEUED | REJECTED`.
No other queue function is required for the expand endpoint. `transition.ts` is
the only production code path that writes the request status together with the
node state (plus the single atomic claim in `claim.ts`).

### Deviations / decisions (with reasons)

1. **State-write grep enforcement added outside the allowed-file list.**
   Acceptance criterion #2 requires the ban to be enforced. Added
   `scripts/check-state-writes.mjs`, a `lint:state-writes` npm script, an entry
   in `verify`, and a CI step (`.github/workflows/ci.yml`). The check scans
   production `src/` (excluding tests) and fails if any file other than
   `transition.ts`/`claim.ts` writes the request status or a node expansion
   state. This mirrors the M5 precedent of adding a script to satisfy the
   brief.
2. **`requestExpansion` creates the request and sets the node to `QUEUED` in one
   transaction, reusing `setNodeState` from `transition.ts`.** Creating the row
   already writes `status = PENDING`, so the initial node sync is not a
   transition; routing it through `setNodeState` keeps node-state writes inside
   the sanctioned module.
3. **`LEGAL_TRANSITIONS.LOCKED` extended with `EXTRACTING` and `COMPLETED`.**
   The brief's constant omitted both, but its own tests require
   `LOCKED → COMPLETED` and Option A requires `LOCKED → EXTRACTING`. Both were
   added; every other list is unchanged.
4. **Claim orders by `createdAt`, not `requestedAt`.** The brief's SQL used
   `requestedAt`, which does not exist on the schema (the column is
   `createdAt`). Used `createdAt` for FIFO.
5. **Driver timestamps coerced in `claim.ts`.** Raw `db.execute` returns the
   `RETURNING "leaseExpiresAt"` value as a string under the node-postgres
   driver here, so the claim maps it through `toDate()` to honour the
   `ClaimedRequest` contract.
6. **Hard 60s shutdown timeout delegated.** `runWorkerLoop` lets the in-flight
   `runExtraction` finish rather than killing it (killing would lose a paid LLM
   result). The provider's own request timeout bounds the call; SIGKILL + the
   reaper are the backstop. No `process.exit` from inside the loop.
7. **Worker entrypoint uses relative imports, not `@/...`.** The `@/*` alias is
   resolved by Next.js/tsc but is not guaranteed under the plain `tsx` runtime;
   the entrypoint is executed directly by `tsx`.
8. **Two stale M6 test assertions updated (out-of-scope but required for a
   green `verify`).** The working tree already contained ADR 002
   (`docs/adr/002-quote-length-relaxed.md`), which relaxed `verbatimQuote`
   max 300→1000 and bumped `PROMPT_VERSION` to `1.0.1`, but two M6 tests still
   asserted the old values. They were verified to pass on the pre-change
   baseline (`git stash` of `prompt.ts`/`schema.ts`) and then updated to the
   ADR's boundary (`schema.test.ts` now checks 1001 fails; the orchestrator test
   now expects `1.0.1`). No test was weakened or deleted.
9. **`processExpansion` releases the lease before rethrowing an unexpected
   error.** The brief says the run loop's catch handles it; doing it in both
   places (idempotently) makes the direct-call path (`processExpansion` invoked
   by a test) safe and satisfies the "lease still released" requirement.

### Environment

- Verified locally against PostgreSQL 18, database `nexus_test`.
- All M7 tests use the M6 fixture provider / stub services; no live LLM or
  Wikipedia calls. No new runtime dependencies were added.

---

## Session log — 2026-10-08 (Milestone 6)

Completed (all NEW unless noted):

- `src/lib/extraction/prompt.ts` — versioned context-free prompt
  (`PROMPT_VERSION = '1.0.0'`), `buildPrompt`. No root-topic, no nesting-level
  variable, no user/session id (Amendment A1). Source text wrapped in
  `<source_text>` delimiters with an anti-injection rule.
- `src/lib/extraction/provider.ts` — `LlmProvider` interface, `LlmError`,
  `MODEL_PRICING`, `computeCostUsd` (conservative fallback + warning for unknown
  models), `zodToJsonSchema`, `validateExtractionJson`, `fetchWithTimeout`
  (hard timeout even if the injected fetch ignores the abort signal),
  `mapHttpError`, and `getProvider` (env-driven; refuses live providers under
  Vitest).
- `src/lib/extraction/providers/openai.ts` — Structured Outputs
  (`json_schema`, `strict: true`) with `convertZodToOpenAiStrictSchema` (strips
  `maxLength`/`minimum`/`minimum`/`maxItems`/…, converts `type: [x, null]` to
  `anyOf`, requires every property, forces `additionalProperties: false`, makes
  optional fields required+nullable, then strips null `brief` before Zod).
- `src/lib/extraction/providers/anthropic.ts` — tool use
  (`emit_extraction`), forced via `tool_choice`; parses the tool input object
  (never `JSON.parse`).
- `src/lib/extraction/providers/deepseek.ts` — OpenAI-compatible
  `response_format: { type: 'json_object' }`, schema echoed into the system
  prompt, strict Zod validation.
- `src/lib/extraction/providers/fixture.ts` — `createLlmFixtureStore`, keyed by
  `sha256(systemPrompt + '\n---\n' + userPrompt)`; `'*'` wildcard for tests;
  `loadDirectory` Zod-validates every fixture at load time.
- `src/lib/extraction/budget.ts` — `reserveBudget` (day/month rollover +
  single conditional `UPDATE`; zero rows → abort) and `reconcileBudget`
  (`GREATEST(0, …)` adjust from reserved to actual; 0 = full refund).
- `src/lib/extraction/validate.ts` — the deterministic pipeline: quote
  verification + chunk filter, A7 entity-mention check, QID resolution with
  WIKIDATA/NEXUS_GENERATED fallback, self-reference, stored-date chronology,
  batch dedupe, and actual-section recording.
- `src/lib/extraction/orchestrator.ts` — `runExtraction`: focal load → source
  resolve → chunk → prompt → cost estimate → budget reserve → ExtractionRun
  BEFORE the call (A9) → provider call → validate → persist accepted edges via
  `insertVerifiedEdge` + `RejectedProposal` → reconcile → result. It does NOT
  touch ExpansionRequest, node state, or user quota (M7).
- `src/lib/extraction/types.ts` — orchestrator I/O types.
- `src/lib/extraction/index.ts` — barrel extended (UPDATE).
- `scripts/run-extraction.ts` — live quality-gate CLI (search → top candidate →
  `createRootNode` → `runExtraction` → human-readable accepted/rejected summary).
- `src/test/fixtures/llm/` — 8 fixtures (see inventory below).
- `src/test/fixtures/extraction/harness.ts` — deterministic stubs + builders.
- `src/test/helpers/llmFixture.ts` — fixture-store helper.
- `docs/STATUS.md` — this update.

Tests added (78; 280 + 78 = 358 total, 33 files):

- `src/test/integration/extraction/prompt.test.ts` (12).
- `src/test/integration/extraction/providers.test.ts` (19).
- `src/test/integration/extraction/fixtures.test.ts` (3).
- `src/test/integration/extraction/budget.test.ts` (8).
- `src/test/integration/extraction/validate.test.ts` (16).
- `src/test/integration/extraction/orchestrator.test.ts` (18).
- `src/test/integration/extraction/injection.test.ts` (3).

`pnpm run verify` output: lint PASS (0 errors, 10 non-null-assertion warnings in
new tests), typecheck PASS, 358/358 tests PASS (33 files), audit 7/7 PASS.

`pnpm run audit:invariants` output (unchanged):

```
Nexus Invariant Audit
=====================
[PASS] Audit 1 (P1): No identity-less nodes (0 violations)
[PASS] Audit 2 (P1): No duplicate QIDs (0 violations)
[PASS] Audit 3 (P2): No self-referential edges (0 violations)
[PASS] Audit 4 (P2): No cycles in the active edge graph (0 violations)
[PASS] Audit 5 (P3): No active edges without verified evidence (0 violations)
[PASS] Audit 6 (P2): No active edges with out-of-bounds importance rank (0 violations)
[PASS] Audit 7 (P1): No duplicate active edges (0 violations)
=====================
Result: 7/7 passed
```

### Prompt version and models

- `PROMPT_VERSION = '1.0.0'` (recorded on every ExtractionRun). `EXTRACTION_SCHEMA_VERSION = '1.0.0'` (unchanged).
- Provider models with pricing entries: `gpt-4o-mini`, `gpt-4o`,
  `claude-3-5-sonnet-latest`, `claude-3-5-haiku-latest`,
  `claude-3-5-haiku-20241022`, `deepseek-chat`, `deepseek-reasoner`.
  `EXTRACTION_PROVIDER` selects openai | anthropic | deepseek; unknown models use
  the most expensive known price and log a warning.
- `scripts/run-extraction.ts` makes live calls and is NOT part of `verify`.
  It was typechecked but not executed (no API keys on the build host) — see the
  M6 report.

### LLM fixture inventory (hand-crafted, Zod-validated at load time)

| Fixture | Purpose |
| --- | --- |
| `wwi-upstream-rich.json` | 5 edges (rich; 3 valid + 2 rejectable) |
| `wwi-upstream-sparse.json` | 0 edges + sparsenessReason |
| `treaty-of-versailles-upstream.json` | rich upstream extraction |
| `treaty-of-versailles-downstream.json` | rich downstream extraction |
| `napoleon-upstream.json` | 2 edges |
| `injection-attempt-malicious.json` | model followed an injection (must reject) |
| `fabricated-quote.json` | quote not present in the source (must reject) |
| `chronology-violation.json` | cause-after-effect (must reject) |

All fixtures are synthetic (`recordedLive: false`); they exist as a stable
inventory. Orchestrator tests register recordings against the exact prompt via
the fixture store (exact hash or `'*'` wildcard).

### Deviations / decisions (with reasons)

1. **`schema.ts` unchanged.** The brief allowed a schema version bump if needed
   to make optional fields nullable. Instead, the OpenAI adapter makes optional
   fields required+nullable only in the provider-facing JSON Schema and strips
   the resulting `brief: null` before Zod validation, so the canonical Zod
   schema (and `.optional()`) is untouched and `EXTRACTION_SCHEMA_VERSION` stays
   `1.0.0`.
2. **Orchestrator persists edges outside one mega-transaction.**
   `insertVerifiedEdge` opens its own SERIALIZABLE transaction and is the sole
   edge write path (P3). Wrapping it inside an outer transaction would degrade
   the isolation level, so each accepted edge is written through
   `insertVerifiedEdge(db, …)` and the rejected-proposal rows + run counts are
   written afterwards. `upsertNode` runs immediately before each edge so the FK
   target exists.
3. **`ValidationContext.sentChunks` is `SentChunkRange[]` (`ChunkRange` plus
   `sectionTitle`).** Structurally assignable to `ChunkRange[]` for
   `verifyQuote`, and it lets the pipeline record the ACTUAL section a quote
   came from (the required warning behaviour).
4. **No `WIKIPEDIA_PAGE` fallback in the pipeline.** The resolver is
   Wikidata-based and exposes no page id on its candidates, so a LOW-confidence
   match deterministically produces a `NEXUS_GENERATED` id. Documented in
   `validate.ts`.
5. **Late rejections reuse `RejectionReason`.** `insertVerifiedEdge` can still
   reject for `CYCLE_DETECTED` (concurrent edge), which is recorded as a
   `RejectedProposal`. `SCHEMA_INVALID` is intentionally unreachable at this
   layer (the provider validates with Zod first; `providers.test.ts` covers the
   `SCHEMA_MISMATCH` path).
6. **`orchestrator`/`validate` tests inject stub services and a fixture
   provider** rather than recorded Wikipedia/Wikidata fixtures. The pipeline's
   only external dependencies are injected via `ExtractionConfig`, so stubs make
   the tests hermetic and deterministic; the M5 client suites still cover the
   live-shaped HTTP fixtures. No test file contains a live provider hostname
   (verified by grep).
7. **CLI narrows the db client.** `src/lib/db/client.ts` returns a union of the
   Neon-HTTP and node-postgres Drizzle types; the graph layer is typed against
   `NodePgDatabase`. The CLI casts once (`db as unknown as Database`) and
   documents why.

---

## Session log — 2026-10-08 (Milestone 5)

Completed (all NEW unless noted):

- `src/lib/wikipedia/rateLimit.ts` — serial minimum-interval `RateLimiter`
  (default 10 req/s; no bursts, deliberately).
- `src/lib/wikipedia/parser.ts` — `parseArticleText` (normalise line endings,
  collapse 3+ newlines, trim; locate headings as standalone lines; build
  `SectionInfo[]` with exact UTF-16 offsets) and `sha256` (node:crypto).
- `src/lib/wikipedia/wikipediaClient.ts` — `createWikipediaClient` (search,
  fetch by page id, by title with redirect+disambiguation handling, by
  revision id), typed `WikipediaError`, mandatory User-Agent, and the shared
  `mediaWikiJsonRequest` retry helper.
- `src/lib/wikipedia/wikidataClient.ts` — `createWikidataClient` (search,
  getEntity, resolveRedirect, getQidForWikipediaTitle), claim/time parsing
  (`parseWikidataTime`, `parseWikidataYear`), shared error/retry.
- `src/lib/wikipedia/qidResolver.ts` — `createResolver` with the four-component
  0-100 scoring model, confidence tiers, and `ENTITY_TYPE_TO_P31` /
  `mapInstanceOfToNodeType`.
- `src/lib/wikipedia/search.ts` — `createSearchService` (HTML-stripped
  snippets; per-candidate sitelink-first QID resolution; failures tolerated).
- `src/lib/wikipedia/sourceDocuments.ts` — revision-keyed cache
  (`fetchAndStore`, `getByRevision`, `getLatest`); never updates a row.
- `src/lib/wikipedia/types.ts` — EXTENDED with `EntityType` and
  `ResolverConfidence`.
- `src/lib/wikipedia/index.ts` — barrel.
- `src/lib/graph/createRootNode.ts` — orchestrates source fetch → QID/page
  identity → node-type + date inference → `upsertNode({ isRoot: true })`, and
  promotes an existing non-root node. **The only path that sets `isRoot=true`.**
- `src/lib/graph/index.ts` — barrel extended.
- `src/test/helpers/httpFixture.ts` — deterministic fixture-backed `fetch`
  (`createFixtureStore`, URL normalisation, hit recording).
- `scripts/record-fixtures.ts` — one-time live-API recorder (run manually;
  not part of `verify`).
- `docs/STATUS.md` — this update.

Tests added (68; 212 + 68 = 280 total, 26 files):

- `src/test/integration/wikipedia/wikipediaClient.test.ts` (12) — missing
  contact e-mail, search shape, empty/zero-result search, by page id, by title,
  disambiguation null, by revision id, rate-limiter acquire, User-Agent spy,
  404 → PAGE_NOT_FOUND, 500 → 3 retries → SERVER_ERROR.
- `src/test/integration/wikipedia/wikidataClient.test.ts` (10) — search,
  getEntity (claims/aliases/sitelinks), P580/P582, sitelink → QID, missing
  title → null, redirect Q840 → Q46, rate limiter, User-Agent, BCE negative
  year, precision 9 → null month/day.
- `src/test/integration/wikipedia/parser.test.ts` (12) — empty, lead-only,
  3-section split, body-mention not a heading, missing title skipped, CRLF,
  triple newline, contiguous offsets, last end offset, repeated headings,
  trim, sha256.
- `src/test/integration/wikipedia/qidResolver.test.ts` (13) — HIGH exact
  match, alias MEDIUM+, type downgrade, date-500-years LOW, NONE, top
  candidate, full score breakdown, sorted/capped candidates, no-hint, QID
  tiebreak, plus 3 mapping assertions.
- `src/test/integration/wikipedia/search.test.ts` (6) — resolved QID, multiple
  candidates, zero results, per-candidate failure tolerance, HTML stripping,
  ranking order.
- `src/test/integration/wikipedia/sourceDocuments.test.ts` (6) — create,
  idempotent same revision, two revisions coexist, getByRevision, getLatest,
  content hash.
- `src/test/integration/graph/createRootNode.test.ts` (9) — HIGH QID,
  no-QID fallback, EXISTING root, promote non-root, SourceDocument linked,
  POLICY inference, range dates, BCE date, LOW confidence fallback.

`pnpm run verify` output: lint PASS (0 errors), typecheck PASS, 280/280 tests
PASS (26 files), audit 7/7 PASS.

### Fixture inventory (recorded live on 2026-10-08)

All fixtures were recorded by `scripts/record-fixtures.ts` against the live
Wikipedia/Wikidata APIs and checked into the repo. Counts: 24 Wikipedia files,
32 Wikidata files.

| Topic | Fixtures | Live/synthetic |
| --- | --- | --- |
| Treaty of Versailles (POLICY, well-defined) | search, page-id extract+sections, title resolve, sitelink, entity Q8736 | live |
| World War I (EVENT, large article) | search, page-id extract+sections, entity Q361 | live |
| Industrial Revolution (PROCESS, range) | search, page-id extract+sections, entity Q2269 | live |
| Napoleon (ACTOR, ambiguous) | search, title resolve, page-id extract+sections, candidate entities/sitelinks | live |
| Mercury (highly ambiguous) | search, disambiguation title resolve, candidate entities/sitelinks | live |
| Battle of Actium (BCE) | title resolve, entity Q160387 | live |
| Zero-result query | search ("Fictional nonsense query xyzabc") | live |
| QID redirect | info for Q840 → Q46 | live |

### TextExtracts vs. action=parse decision

**Both, split by concern.** Plain text comes from TextExtracts
(`prop=extracts&explaintext=1&exsectionformat=plain`); the authoritative,
hierarchical section-title list comes from `action=parse&prop=sections`
(`pageid` for current, `oldid` for revision-pinned). `exsectionformat=plain`
emits headings as bare lines with no structural markers, so `action=parse` is
needed to know which bare lines are headings. `parseArticleText` then locates
each title as a standalone line and computes offsets, skipping titles absent
from the extract. `prop=sections` is deprecated in favour of `prop=tocdata`;
`tocdata` was evaluated but `sections` remains supported and simpler. If it is
removed, switch to `tocdata` with a one-line change.

### P31 QID mappings used by the resolver (verified against live labels)

- **EVENT:** Q1190554 (occurrence), Q1656682 (planned event), Q178561 (battle),
  Q198 (war), Q273120 (protest), Q13418847 (historical event)
- **ACTOR:** Q5 (human), Q215627 (person), Q16334295 (group of humans),
  Q3024240 (historical country), Q43229 (organization)
- **POLICY:** Q7748 (law), Q49371 (legislation), Q131569 (treaty),
  Q625298 (peace treaty)
- **PROCESS:** Q1150070 (change), Q3249551 (process), Q1190554 (occurrence),
  Q40231 (public election)
- **INSTITUTION:** Q43229 (organization), Q16334295 (group of humans),
  Q4830453 (business), Q327333 (government agency), Q17149090 (armed org)
- **IDEOLOGY:** Q7257 (ideology), Q179805 (political philosophy),
  Q49773 (social movement)
- **PLACE:** Q17334923 (physical location), Q486972 (human settlement),
  Q82794 (region), Q3624078 (sovereign state), Q6256 (country)
- **TECHNOLOGY:** Q11016 (technology), Q39546 (physical tool),
  Q11862829 (academic discipline)

The brief's example QIDs were partly wrong and were corrected: Q7944 is
"earthquake" (not treaty), Q171240 is the London Stock Exchange (not the
Treaty of Versailles), and Q6534608/Q1519799/Q1499346 were persons, a ministry
and a fish. Overlapping QIDs are resolved by a fixed type order
(EVENT → … → PLACE); the treaty QIDs were removed from EVENT so that a peace
treaty maps to POLICY, which the `createRootNode` test asserts.

### User-Agent + rate-limiter evidence

- `wikipediaClient.test.ts` › "sends the User-Agent header on every request"
  wraps the fixture fetch, records every request's headers, and asserts
  `Nexus/1.0 (dev@example.com) nexus-history-graph` on all of them.
- `wikidataClient.test.ts` › same test for the Wikidata client.
- `wikipediaClient.test.ts` › "acquires a rate limiter token before each
  request" and `wikidataClient.test.ts` › "calls the rate limiter before each
  request" spy on `RateLimiter.acquire` and assert it was called.

### isRoot=true audit

`grep isRoot src/lib` confirms the only production assignments are in
`createRootNode.ts` (`isRoot: true` on insert, `.set({ isRoot: true })` on
promotion). `upsertNode.ts` writes `isRoot: input.isRoot ?? false`, so its
default is false. The only test that sets it is `createRootNode.test.ts`
(seeding a pre-existing root).

### Deviations / decisions (with reasons)

1. **Brief's example QIDs corrected to real values.** Q171240 (London Stock
   Exchange, not Treaty of Versailles) and Q7944 (earthquake, not treaty) were
   wrong; tests use the real QIDs recorded from the live APIs (Q8736, Q625298,
   Q131569, …). Documented above.
2. **`fetchArticleByTitle("Napoleon")` is not a disambiguation page.** Live
   Wikipedia returns article content for "Napoleon"; the disambiguation-null
   test uses "Mercury" (pageprops.disambiguation present), which is the
   required "highly ambiguous common word" topic.
3. **Revision pinning uses `revids=`/`oldid=` and the current TextExtracts
   content.** TextExtracts cannot return an arbitrary revision's plain text;
   the client records the exact `revid` it resolved and fetches the section
   list at that `oldid`. This is the closest the API allows and is documented
   in `wikipediaClient.ts`.
4. **A separate `action=parse&prop=sections` request is made per article.**
   Two requests (extract + sections) instead of the brief's single extract
   request. Necessary for reliable section boundaries (see the parsing
   decision).
5. **Test seam `sleep?` added to both client option objects.** Retry backoff
   would otherwise make the 500/429 tests take ~7s / ~5s. Production omits it;
   tests pass a no-op. This is additive to the specified options.
6. **`scripts/record-fixtures.ts` created.** Explicitly recommended by the
   brief's fixture section though not in the "files allowed to change" list.
   It is not executed by `verify` and performs the only live calls in the repo.
7. **Resolver scoring tests use a stub `WikidataClient`.** Encoding every
   scoring edge case (type disagreement, 500-year date gap, NONE) as recorded
   fixtures would be brittle and large; the resolver only consumes the
   `WikidataClient` interface, so a deterministic in-memory stub is used for
   those cases. A fixture-backed happy path is covered by `search.test.ts` and
   the Wikidata client tests.
8. **`prop=sections` deprecation warning is tolerated.** MediaWiki still
   serves it; see the parsing decision for the migration note.

---

## Session log — 2026-10-08 (Milestone 4)

Completed (all NEW):

- `src/lib/graph/types.ts` — application-level input/output types plus the
  Drizzle client aliases (`Database`, `Transaction`, `DbClient`).
- `src/lib/graph/cycleCheck.ts` — `checkForCycle` (recursive CTE walking
  upstream from the proposed cause; self-edge short-circuit) and
  `hasActiveCycle` (full-graph cycle probe used by merge).
- `src/lib/graph/upsertNode.ts` — canonical identity upsert (P1). QID /
  nexusGeneratedId use `ON CONFLICT DO NOTHING` + re-select; wikipediaPageId
  (non-unique) uses select-then-insert. Metadata fill-in only (never overwrites
  or downgrades).
- `src/lib/graph/insertVerifiedEdge.ts` — **the only edge write path**.
  Validates self-edge / importance / evidence before opening a transaction,
  then runs cycle check, stored-date chronology, and the raw `INSERT ... ON
  CONFLICT (...) WHERE status='ACTIVE' DO NOTHING` + evidence insert inside one
  SERIALIZABLE transaction, wrapped in a jittered retry (`40001` / `40P01`).
  Also `insertVerifiedEdgeBatch` (lexicographic lock ordering, per-edge tx).
- `src/lib/graph/mergeNodes.ts` — P1 reconciliation: repoints edges, retires
  duplicate ACTIVE edges (keeping the earlier `createdAt`) and moves evidence,
  repoints expansion requests / extraction runs, re-checks P2, logs
  `qidReconciliations`, deletes the removed node.
- `src/lib/graph/traversal.ts` — `getNodeNeighborhood`, `getAncestors`,
  `getDescendants` (recursive CTEs, deduplicated), `distanceToNearestRoot`.
- `src/lib/graph/index.ts` — barrel.
- `src/test/helpers/fixtures.ts` — added `uniqueQid`, `insertSourceDocument`,
  `insertExtractionRun`, and a fourth fixture node; `createTestFixtures`
  unchanged in shape apart from the new `nodeD`.
- `src/test/helpers/edgeHelper.ts` — added `makeEvidence` and
  `insertVerifiedEdgeThroughApp` (the production write path). The existing
  raw-SQL probe helpers are retained for the M2 invariant suite.
- `docs/STATUS.md` — this update.

Tests added (65 new; 60 graph + 5 retry; 147 + 65 = 212 total):

- `src/test/integration/graph/upsertNode.test.ts` (13) — identity schemes,
  P1 violation, QID pattern, metadata no-overwrite, date upgrade/no-downgrade,
  concurrent same-QID upsert (two pools), DAY-without-day guard.
- `src/test/integration/graph/insertVerifiedEdge.test.ts` (19) — create /
  ACTIVE / chronology status, evidence offsets, EXISTING + accumulated
  evidence, per-relation edges, SELF_EDGE, NO_EVIDENCE, rank 0/11,
  CHRONOLOGY_VIOLATION, UNVERIFIED dates, cycle rejection, deferred P3 trigger,
  batch accept, batch partition, concurrent identical inserts, concurrent
  opposite edges.
- `src/test/integration/graph/cycleCheck.test.ts` (8) — empty, 2-node,
  3-node, branch, separate chains, self-edge fast path, long chain, diamond.
- `src/test/integration/graph/mergeNodes.test.ts` (8) — repoint + log,
  duplicate retirement with evidence move, self-edge removal, missing node,
  cycle rollback, node deletion, expansion-request repoint, count accuracy.
- `src/test/integration/graph/traversal.test.ts` (12) — neighborhood
  causes/effects/empty/null, bounded ancestors, dedupe, descendants,
  distance-to-root 0/2/2/null.
- `src/test/integration/graph/retry.test.ts` (5) — classification (direct +
  nested `40001`, `40P01`, non-retryable), fake-runner retry/exhaustion, and a
  **real PostgreSQL 40001** provoked by two barrier-synchronised SERIALIZABLE
  transactions (retry observed; `invocations >= 3`).

`pnpm run verify` output: lint PASS (0 errors), typecheck PASS, 212/212 tests
PASS (19 files), audit 7/7 PASS.

`pnpm run audit:invariants` output:

```
Nexus Invariant Audit
=====================
[PASS] Audit 1 (P1): No identity-less nodes (0 violations)
[PASS] Audit 2 (P1): No duplicate QIDs (0 violations)
[PASS] Audit 3 (P2): No self-referential edges (0 violations)
[PASS] Audit 4 (P2): No cycles in the active edge graph (0 violations)
[PASS] Audit 5 (P3): No active edges without verified evidence (0 violations)
[PASS] Audit 6 (P2): No active edges with out-of-bounds importance rank (0 violations)
[PASS] Audit 7 (P1): No duplicate active edges (0 violations)
=====================
Result: 7/7 passed
```

Deviations / API decisions (with reasons):

1. **ON CONFLICT is raw SQL.** Drizzle's `.onConflictDoNothing()` cannot express
   a partial-index conflict target of the form
   `ON CONFLICT (cols) WHERE status='ACTIVE' DO NOTHING`, so the edge insert
   uses `tx.execute(sql\`...\`)`. Evidence spans still use `tx.insert`.
2. **`mergeNodes` deletes self-edge rows (P4 deviation).** The
   `chk_no_self_edge` CHECK applies to every row regardless of status, so an
   edge that would become `Y -> Y` cannot be stored as SUPERSEDED. It is
   removed together with its evidence (the FK forces the evidence delete). A
   node delete is already sanctioned by the task; this is the minimal
   additional delete required by the schema. Documented in `mergeNodes.ts`.
3. **`mergeNodes` repoints `expansionRequests.nodeId`.** The FK is `NOT NULL`
   with no `ON DELETE`, so the removed node cannot be deleted otherwise. The
   brief's optional handling ("nullify or repoint") is implemented as repoint;
   the merge test asserts it.
4. **`mergeNodes` keeps the earlier `createdAt`.** When the surviving ACTIVE
   edge is the one being repointed (it is older), the function retires the
   existing target edge instead and repoints the survivor.
5. **`cycleCheck` seeds the path with the proposed cause and de-duplicates.**
   The brief's CTE returns `path || effect` which can end in a doubled id; the
   returned `cyclePath` (debugging only) is seeded `[cause, ...ancestors]` and
   consecutive duplicates collapsed.
6. **Cycle test 4 corrected.** The brief's "A→B, A→C, C→D, propose D→B" is not
   a cycle (nothing reaches D from B). The test proposes `D→A` instead, which
   is a genuine cycle (A→C→D→A).
7. **Upsert test 7 interpretation.** `label` is `NOT NULL` and required, so
   "null label" is interpreted as "an existing non-empty label is never
   overwritten".
8. **Raw-SQL probe retained in `edgeHelper.ts`.** The M2 invariant tests
   (`src/test/invariants/`, out of scope) deliberately bypass the application
   path to assert database-level defence-in-depth (self-edge CHECK, importance
   CHECK, partial unique index, deferred P3 trigger). They import
   `edgeInsertSql` / `insertEdgeWithEvidence`; removing those would break tests
   this task must not modify. They use raw SQL, **not**
   `db.insert(edges)`, so the ESLint ban does not fire. M4 tests use the new
   `insertVerifiedEdgeThroughApp` wrapper.
9. **`withSerializableRetry` / `isSerializationFailure` are exported** so the
   retry logic can be tested directly (including against real PostgreSQL).

Verification performed locally (PostgreSQL 18, database `nexus_test`):

- `pnpm run lint`, `pnpm run typecheck` clean.
- Graph suite run four times; the concurrency tests were stable.
- Real `40001` retry confirmed via temporary instrumentation ("[retry-diag]
  serialization failure on attempt 1" under the barrier test), then removed.
- Grep confirms no Drizzle `insert(edges)` anywhere; the only raw
  `INSERT INTO "edges"` statements are `insertVerifiedEdge.ts` (production) and
  the documented test probe in `edgeHelper.ts`.

---

## Session log — 2026-10-08 (Milestone 3)

Completed (all NEW, pure functions, no I/O):

- `src/lib/quote/normalize.ts` — single-pass, position-preserving normalizer
  (`normalize` / `normalizeString`). Strips citation markers, NFC (per canonical
  composition cluster), collapses Unicode whitespace, lowercases, trims; returns
  `normalized`, `toOriginal: Int32Array`, and `rawText`. ~20 ms for 100 KB.
- `src/lib/quote/verify.ts` — `verifyQuote` (indexOf-all → map offsets → chunk
  filter → first valid match; 10-char minimum) and `quoteMentionsAnyEntity`
  (Amendment A7 token check).
- `src/lib/quote/index.ts` — barrel.
- `src/lib/dates/intervals.ts` — `DatePrecision`, `PartialDate`, `YearInterval`,
  `toYearInterval`, `intervalsOverlap`, `couldPrecede`.
- `src/lib/dates/chronology.ts` — `checkChronology` → VERIFIED / UNVERIFIED /
  VIOLATION (reason includes both year ranges).
- `src/lib/dates/index.ts` — barrel.
- `src/lib/extraction/schema.ts` — Zod schemas/types for the LLM output contract
  (Amendment A1: no ROOT_TOPIC/DEPTH). `EXTRACTION_SCHEMA_VERSION = '1.0.0'`.
- `src/lib/extraction/index.ts` — barrel.
- `src/lib/wikipedia/types.ts` — `SectionInfo`, `Direction`, `Chunk`.
- `src/lib/wikipedia/chunker.ts` — `chunkArticle` (priority 1/10/20/50, exclude
  list, lead-exempt character budget). Pure.
- `src/lib/wikipedia/index.ts` — barrel.
- Fixtures: `src/test/fixtures/sources/{wwi-abbreviated,stub-article,long-article}.{txt,json}`
  (offsets verified exact: 5000 / 400 / 29400 chars).
- `fast-check` 4.10.2 added as a dev dependency.
- `docs/STATUS.md` — this update.

Tests added (116, all passing; plus the 31 M2 tests = 147):

- `src/test/unit/quote/normalize.test.ts` (29) — markers, whitespace, NFC,
  mapping; 4 fast-check properties (offset validity, monotonic map, idempotence,
  length consistency).
- `src/test/unit/quote/verify.test.ts` (23) — match/case/whitespace variants,
  marker span, chunk filtering, entity mention; 3 fast-check properties.
- `src/test/unit/dates/intervals.test.ts` (20) — precision → interval, overlap,
  precede; 1 width property.
- `src/test/unit/dates/chronology.test.ts` (15) — all rule branches.
- `src/test/unit/extraction/schema.test.ts` (15) — valid/invalid shapes, strict,
  bounds.
- `src/test/unit/extraction/enum-parity.test.ts` (1) — Zod enums vs Drizzle
  pgEnums (all four pairs).
- `src/test/unit/wikipedia/chunker.test.ts` (13) — priorities, exclusions,
  ordering, budget, fixtures; 1 offset-integrity property.

`pnpm run verify` output: lint PASS, typecheck PASS, 147/147 tests PASS
(13 files), audit 7/7 PASS.

`pnpm run audit:invariants` output (unchanged):

```
Nexus Invariant Audit
=====================
[PASS] Audit 1 (P1): No identity-less nodes (0 violations)
[PASS] Audit 2 (P1): No duplicate QIDs (0 violations)
[PASS] Audit 3 (P2): No self-referential edges (0 violations)
[PASS] Audit 4 (P2): No cycles in the active edge graph (0 violations)
[PASS] Audit 5 (P3): No active edges without verified evidence (0 violations)
[PASS] Audit 6 (P2): No active edges with out-of-bounds importance rank (0 violations)
[PASS] Audit 7 (P1): No duplicate active edges (0 violations)
=====================
Result: 7/7 passed
```

Deviations / API decisions (with reasons):

1. **`NormalizedText` carries `rawText`.** The brief lists only `normalized`
   and `toOriginal`, but `verifyQuote` must return `matchedOriginalText`
   (a slice of the original) and its specified signature has no rawText
   parameter. Adding `rawText` to the value returned by `normalize()` keeps
   `verifyQuote`'s signature exactly as specified. Documented in `normalize.ts`.
2. **`matchCitationMarker` treats `[dubious…]` as any content starting with
   `dubious`** (case-insensitive), per "`[dubious` followed by any characters
   followed by `]`".
3. **`MULTIPLE_MATCHES_OUTSIDE_CHUNKS` is part of the result union but is not
   emitted** — the brief's algorithm says a match that exists but falls outside
   the sent chunks returns `OUTSIDE_SENT_CHUNKS`.
4. **NFC is applied per canonical composition cluster** (base + combining
   marks, plus Hangul jamo pairs) rather than per UTF-16 code unit. Per-code-unit
   NFC cannot compose `e` + U+0301 into `é`, which would violate the required
   precomposed/decomposed equality. Cluster boundaries are composition-safe, so
   the result is identical to whole-string NFC.
5. **Property test 21 wording adjusted to a true invariant.** The literal claim
   ("any raw substring of length ≥ 10 verifies") is false for substrings that
   split a citation marker; the test generates contiguous word substrings and
   asserts the matched text normalizes to the same normalized quote. An extra
   property asserts NOT_FOUND for a disjoint-alphabet quote.
6. **`pnpm-lock.yaml` changed** as a necessary consequence of adding
   `fast-check` (the task only named `package.json`, but a dependency cannot be
   added without the lockfile).

---

## Session log — 2026-10-08 (Milestone 2)

Completed:

- `src/lib/db/schema.ts` — full Drizzle schema: 12 enums, 11 tables
  (`nodes`, `edges`, `sourceDocuments`, `extractionRuns`, `evidenceSpans`,
  `expansionRequests`, `rejectedProposals`, `userQuotas`, `globalBudget`,
  `edgeFeedback`, `qidReconciliations`), indexes/unique constraints, and all
  `relations()` for relational queries.
- Migration strategy **Option A**: custom SQL (5 CHECK constraints, 2 partial
  unique indexes, the deferred P3 constraint trigger, and the globalBudget
  seed) is appended to the Drizzle-generated migration
  `src/lib/db/migrations/0000_chemical_lilith.sql`, delimited by
  `--> statement-breakpoint` markers so the drizzle migrator applies it as one
  ordered migration. Rationale: a single self-contained migration that both
  `db:migrate` and the test helper apply automatically.
- `src/lib/db/audit.ts` — real `pg`-backed audit running all 7 queries with
  PASS/FAIL output; exits 1 on any violation.
- `src/test/helpers/db.ts` — `getTestDb` / `resetTestDb` / `closeTestDb`
  (+ `getTestDatabaseUrl`, `getPgErrorCode`, `captureError`, `errorChainMessage`).
  Applies migrations programmatically; test files serialise via a session
  advisory lock; reset uses `TRUNCATE ... CASCADE` + re-seed.
- `src/test/helpers/fixtures.ts` — `insertNode`, `createTestFixtures`.
- `src/test/helpers/edgeHelper.ts` — `edgeInsertSql`,
  `insertEdgeWithEvidence` (edge + VERIFIED evidence in one transaction; raw
  SQL for the Edge insert to respect the Edge-insert lint ban).
- `src/test/invariants/` — 5 test files, 30 tests.
- `docs/STATUS.md` — this update.

Tests added (30 invariant + 1 pre-existing smoke = 31 total, all passing):

- `p1-canonical-identity.test.ts` (8): insert with QID; only
  `wikipediaPageId`; only `nexusGeneratedId`; reject neither identity
  (`chk_node_identity`, 23514); reject duplicate QID (23505); reject duplicate
  `nexusGeneratedId` (23505); allow shared `wikipediaPageId` with distinct
  QIDs; concurrent same-QID inserts across two independent pools → exactly one
  row, one 23505.
- `p2-acyclicity.test.ts` (8): A→B succeeds; self-edge rejected (23514);
  `importanceRank` 0 and 11 rejected (23514); rank 5 accepted; second ACTIVE
  triple rejected (23505); ACTIVE+SUPERSEDED same triple allowed; same pair
  different `relationType` allowed.
- `p3-evidence-constraint.test.ts` (5): ACTIVE edge + VERIFIED evidence
  succeeds; ACTIVE edge with no evidence rejected at COMMIT with
  `P3 VIOLATION` (23514); NOT_FOUND-only evidence rejected; deleting evidence
  after commit is NOT caught (documented KNOWN GAP, audit 5 catches it);
  SUPERSEDED edge without evidence allowed.
- `p1-p2-constraints.test.ts` (6): DAY-without-day, MONTH-without-month,
  YEAR-without-year rejected; UNKNOWN/all-null accepted; YEAR/-44 (BCE)
  accepted; DAY end-precision without end day rejected.
- `expansion-constraints.test.ts` (3): second PENDING same `(node, direction)`
  rejected (23505); PENDING+COMPLETED allowed; PENDING UPSTREAM + PENDING
  DOWNSTREAM allowed.

Verification performed locally (PostgreSQL 18, database `nexus_test`):

- `pnpm run db:migrate` against a freshly created database — applied cleanly.
- `pnpm run db:push --force` against a separate fresh database — applies the
  declarative schema (tables, columns, FKs, indexes, unique constraints) but,
  by design, not the hand-written custom objects (CHECKs, partial indexes,
  trigger, seed), which only exist in the migration. `db:migrate` is therefore
  the authoritative path.
- Post-migration catalog check: 11 tables, 5 CHECK constraints, 12 FKs,
  4 unique constraints, both partial unique indexes, and
  `trg_edge_evidence` (`tgdeferrable = true`, `tginitdeferred = true`).
- Planted a 2-node cycle to exercise the audit failure path: audit 4 reported
  `2 violations` and the script exited 1. Cleaned up; audit back to 7/7.

`pnpm run verify` output: lint PASS, typecheck PASS, 31/31 tests PASS,
audit 7/7 PASS.

`pnpm run audit:invariants` output (empty database):

```
Nexus Invariant Audit
=====================
[PASS] Audit 1 (P1): No identity-less nodes (0 violations)
[PASS] Audit 2 (P1): No duplicate QIDs (0 violations)
[PASS] Audit 3 (P2): No self-referential edges (0 violations)
[PASS] Audit 4 (P2): No cycles in the active edge graph (0 violations)
[PASS] Audit 5 (P3): No active edges without verified evidence (0 violations)
[PASS] Audit 6 (P2): No active edges with out-of-bounds importance rank (0 violations)
[PASS] Audit 7 (P1): No duplicate active edges (0 violations)
=====================
Result: 7/7 passed
```

Deviations from the task brief (with reasons):

1. **Audit 4 query corrected.** The brief's recursive CTE excludes any node
   already in `path`, which also excludes the edge that closes a cycle, so it
   can only ever detect self-loops. The implementation instead allows the single
   closing step back to the chain's `start` (while still pruning intermediate
   revisits). Verified by planting A→B→A: the audit reports a violation.
   Documented in a comment in `src/lib/db/audit.ts`.
2. **Per-table column lists win over the general "every table has createdAt and
   updatedAt" rule.** `userQuotas` and `globalBudget` therefore have no
   `createdAt`, and `edgeFeedback` / `qidReconciliations` have neither
   `updatedAt` nor (for `qidReconciliations`) `createdAt`, matching the explicit
   per-table specs. Commented in `schema.ts`.
3. **`wikipediaPageId` is intentionally not unique.** The brief explicitly says
   so (redirects); test 5.1.7 documents and asserts the behavior.
4. **Test serialisation.** `vitest.config.ts` is outside the files this task
   allows changing, and its `pool: 'forks'` runs test files in parallel against
   one shared database. `getTestDb` therefore takes a session-level Postgres
   advisory lock held for the life of a test file, so files run one at a time
   instead of truncating each other's data.
5. **Edge inserts in test helpers use raw SQL.** AGENTS.md forbids Drizzle
   `insert(edges)` outside the (M4) `insertVerifiedEdge()`; raw SQL both respects
   that lint rule and still exercises the real DB constraints.
6. **`package.json` / `client.ts` / `drizzle.config.ts` unchanged.** The
   `audit:invariants` and `verify` scripts already existed from M1; the schema
   import path did not change; no new dependencies were required.

Environment notes:

- No Docker on this host; verified against the local PostgreSQL 18 service
  (`nexus_test`). CI uses the `postgres:16-alpine` service with
  `DATABASE_URL=...nexus_test`.

---

## Session log — 2026-10-08 (Milestone 1)

Completed:

- pnpm workspace initialized; all production and dev dependencies installed.
- TypeScript strict mode + `noUncheckedIndexedAccess` + `@/*` path alias.
- Next.js 15 App Router skeleton (`src/app/`).
- Drizzle ORM + drizzle-kit configured (`drizzle.config.ts`).
- Vitest configured for `src/test/**/*.test.ts` (node, forks pool, 30s timeout).
- Playwright installed (no tests yet).
- ESLint configured with the Edge-insert ban and forbidden-list rules.
- GitHub Actions CI workflow added.
- Docs: STATUS, ADR 001, architecture blueprint + v2 delta.

Tests passing:

- `src/test/smoke.test.ts` — "Smoke test > should pass".

`pnpm run audit:invariants` output:

```
Running invariant audits...
All audits passed (0 queries configured).
```

Deviations / environment notes:

- No Docker on the build host, so `docker compose up -d` and the GitHub
  Actions run could not be exercised locally. `db:migrate` was validated
  end-to-end against a real local PostgreSQL.
- `drizzle-kit` 0.31 no longer accepts `driver: 'neon-http'`; connection is
  chosen from `dbCredentials.url` (works for Neon and local Postgres).
- Added `pnpm-workspace.yaml` (`allowBuilds: esbuild`) and `packageManager`
  because pnpm v12 no longer reads the `pnpm` field from `package.json`
  and blocks dependency build scripts by default.
- Added `src/app/layout.tsx` (App Router requires a root layout), `pg` +
  `@types/pg` (local Postgres driver), and `tsx` (worker/audit scripts).
