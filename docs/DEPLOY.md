# Nexus Deployment Runbook

This runbook covers taking Nexus from a fresh clone to a deployed production
instance, and operating it afterwards. It assumes the architecture described in
`docs/architecture-v2-delta.md`: a Next.js (App Router) web tier, a separate
long-lived queue worker, PostgreSQL (Neon in production), and an LLM provider.

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [Environment variables](#2-environment-variables)
3. [Local development](#3-local-development)
4. [Production deployment (Vercel + Railway/Render)](#4-production-deployment-vercel--railwayrender)
5. [First-time setup](#5-first-time-setup)
6. [Monitoring](#6-monitoring)
7. [Incident response](#7-incident-response)
8. [Scaling notes](#8-scaling-notes)
- [Appendix A: Admin API](#appendix-a-admin-api)
- [Appendix B: Playwright smoke test](#appendix-b-playwright-smoke-test)

---

## 1. Prerequisites

| Requirement | Notes |
| --- | --- |
| Node.js 20 LTS | The app targets Node 20 (`engines`); Node 22+ also works. |
| pnpm | `packageManager` is pinned; use `corepack enable`. |
| PostgreSQL | Neon for production; Docker/Postgres 16+ for local. |
| Vercel account | Hosts the Next.js app + cron. A container host also works. |
| Container host | Railway / Render / Fly / a VPS for the queue worker. |
| LLM API key | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `DEEPSEEK_API_KEY`. |
| Wikipedia contact e-mail | Required by the MediaWiki User-Agent policy. |

---

## 2. Environment variables

Grouped by concern. Copy `.env.example` to `.env.local` for local development;
set these in the Vercel dashboard (web) and the container host (worker).

### Database

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | Connection string. `*.neon.tech` uses the Neon HTTP driver; anything else uses `pg`. |
| `DIRECT_URL` | prod | Non-pooled URL used by `drizzle-kit` for migrations (Neon direct endpoint). |

### Auth

| Variable | Required | Description |
| --- | --- | --- |
| `AUTH_SECRET` (or `NEXTAUTH_SECRET`) | yes | Signing secret for sessions. Generate with `openssl rand -base64 32`. |
| `NEXTAUTH_URL` | yes | Public origin, e.g. `https://nexus.example.com`. |
| `ALLOWED_EMAILS` | yes | Comma-separated invite allowlist. **Empty = nobody can sign in.** |
| `ADMIN_EMAILS` | yes (for admin) | Comma-separated admin allowlist. **Empty = `/api/admin/*` denies all.** |
| `CRON_SECRET` | recommended | Shared secret Vercel Cron sends to `/api/admin/audit`. |
| `EMAIL_PROVIDER` | no | `console` (default) / `resend` / `postmark` / `ses`. Non-console currently falls back to console with a warning. |
| `EMAIL_FROM` | no | From address for magic links. |
| `EMAIL_API_KEY` | no | Key for the (future) real email service. |

### LLM

| Variable | Required | Description |
| --- | --- | --- |
| `EXTRACTION_PROVIDER` | yes | `openai` / `anthropic` / `deepseek`. |
| `OPENAI_API_KEY` | conditional | Required when `EXTRACTION_PROVIDER=openai`. |
| `ANTHROPIC_API_KEY` | conditional | Required when `EXTRACTION_PROVIDER=anthropic`. |
| `DEEPSEEK_API_KEY` | conditional | Required when `EXTRACTION_PROVIDER=deepseek`. |

### Wikipedia

| Variable | Required | Description |
| --- | --- | --- |
| `WIKIPEDIA_CONTACT_EMAIL` | yes | Embedded in the `User-Agent`; no requests are made without it. |

### Budget

| Variable | Required | Description |
| --- | --- | --- |
| `GLOBAL_DAILY_BUDGET_USD` | no | Daily global spend cap (default 50). |
| `GLOBAL_MONTHLY_BUDGET_USD` | no | Monthly global spend cap (default 500). |

### Worker / operational

| Variable | Required | Description |
| --- | --- | --- |
| `WORKER_ID` | no | Human-readable lease owner; defaults to `worker-<pid>-<ts>`. |
| `NODE_ENV` | yes in prod | `production` on Vercel/containers. |

---

## 3. Local development

```bash
# 1. Database
docker compose up -d postgres

# 2. Dependencies
corepack enable
pnpm install

# 3. Env
cp .env.example .env.local        # then edit DATABASE_URL + secrets

# 4. Schema
pnpm run db:migrate

# 5. Web tier (terminal 1)
pnpm run dev                      # http://localhost:3000

# 6. Worker (terminal 2) — required for expansions
pnpm run worker
```

The default email transport logs the magic link to the web-tier stdout:

```
[AUTH] Magic link for you@example.com: http://localhost:3000/api/auth/callback/email?...
```

Open that URL to sign in. `ALLOWED_EMAILS` must contain your address (in dev an
empty allowlist permits any address; production fails closed).

Quality gates:

```bash
pnpm run verify           # lint + state-writes + typecheck + tests + audits
pnpm run build            # production Next.js build
```

---

## 4. Production deployment (Vercel + Railway/Render)

### 4.1 Database (Neon)

1. Create a Neon project and a production branch.
2. Copy the **pooled** connection string into `DATABASE_URL` and the **direct**
   string into `DIRECT_URL`.
3. Apply migrations from a machine with the production env:
   ```bash
   DATABASE_URL=... DIRECT_URL=... pnpm run db:migrate
   ```
   Never edit an applied migration; add a new one (`pnpm run db:generate`).

### 4.2 Web tier (Vercel)

1. Import the repository into Vercel.
2. Framework preset: Next.js. Build command `pnpm run build`; install with pnpm.
3. Add every variable from section 2 (database, auth, LLM, Wikipedia, budget)
   for the Production environment.
4. Deploy. `vercel.json` registers the 6-hourly audit cron:
   ```json
   { "crons": [{ "path": "/api/admin/audit", "schedule": "0 */6 * * *" }] }
   ```
   Vercel sends `Authorization: Bearer $CRON_SECRET`; the route accepts it.

> **SSE note.** `/api/expansions/[id]/stream` declares `maxDuration = 120`. On
> Vercel this needs a Pro plan; on Hobby, clients reconnect after the function
> is cut. A polling fallback (`GET /api/expansions/{id}` every 2s) is documented
> in `docs/STATUS.md`.

### 4.3 Worker (Railway / Render / Fly / VPS)

The worker is a long-lived process and **cannot run on Vercel serverless**.

1. Create a service from the same repository.
2. Start command: `pnpm run worker` (or `tsx src/worker/index.ts`).
3. Set `DATABASE_URL`, `WIKIPEDIA_CONTACT_EMAIL`, the provider key, and
   `WORKER_ID` (e.g. `worker-prod-1`).
4. Set `DIRECT_URL` only if the worker runs migrations (it does not).
5. Scale by running more containers; `SKIP LOCKED` prevents collisions.

### 4.4 Container-host alternative

`docker-compose.yml` ships a `worker` service for local/e2e parity. For a
production VPS, run the web tier behind a reverse proxy and the worker as a
systemd unit or a second compose service with the production env.

---

## 5. First-time setup

1. Add your address to `ALLOWED_EMAILS` **and** `ADMIN_EMAILS`; redeploy.
2. Sign in through the UI (or the console magic link) and confirm the session
   establishes.
3. Run a smoke extraction through the UI: search a well-defined topic (e.g.
   "Treaty of Versailles"), pick the top candidate, click **Causes**.
4. Confirm nodes appear and evidence renders in the side panel.
5. Run `GET /api/admin/audit` (section 6) and confirm 14/14 pass.
6. Check `GET /api/admin/cost` shows budget numbers.

---

## 6. Monitoring

| Surface | What to watch |
| --- | --- |
| `GET /api/admin/audit` | 14/14 invariants. Runs automatically every 6h via cron; also callable manually (admin session or `CRON_SECRET`). |
| `GET /api/admin/cost` | `spentTodayUsd` / `spentThisMonthUsd` vs caps; recent run counts. |
| `POST /api/admin/kill-switch` | Flip `isPaused` to stop all new expansions instantly. |
| Neon dashboard | Connections, storage, slow queries. |
| Container host logs | Worker crash-loops, provider errors, lease reaping. |

```bash
# Manual audit (admin session cookie or cron secret)
curl -H "authorization: Bearer $CRON_SECRET" https://nexus.example.com/api/admin/audit

# Cost summary
curl -H "x-cron-secret: $CRON_SECRET" https://nexus.example.com/api/admin/cost

# Emergency stop
curl -X POST -H "x-cron-secret: $CRON_SECRET" \
  -H "content-type: application/json" \
  -d '{"isPaused":true}' https://nexus.example.com/api/admin/kill-switch
```

Audits run automatically in-container only if you wire
`startAuditScheduler(...)` into a small cron entrypoint; the Vercel cron is the
default.

---

## 7. Incident response

### Budget overrun / runaway cost

1. `POST /api/admin/kill-switch {"isPaused": true}` — new expansions are
   rejected with `ABORTED_BUDGET` (the reservation UPDATE fails).
2. Inspect `GET /api/admin/cost` and extraction-run history.
3. Identify the cause (retry storm, provider price change, abuse).
4. Fix, then resume with `{"isPaused": false}`.

### Graph corruption (invariant violation)

1. `GET /api/admin/audit` to see which audit failed and how many violations.
2. Inspect the offending rows (the audit result names the invariant).
3. Repair at the DB level (never `DELETE`; prefer `SUPERSEDED` / merge).
4. Re-run the audit to confirm 0 violations.

### LLM provider outage

1. Provision a key for an alternate provider.
2. Set `EXTRACTION_PROVIDER` on the **worker** to `openai` / `anthropic` /
   `deepseek` and its key.
3. Restart the worker.

### Worker crash / OOM

- Container hosts auto-restart the process.
- A killed worker leaves a lease in the DB; a sibling worker (or the restarted
  worker) reaps stale leases after 5 minutes and returns the request to
  `PENDING`.
- In-flight requests retry with 30s / 120s backoff, then `FAILED` after 3
  attempts.

### Elevated error rate

- Check the web-tier logs for `[api] internal error:` lines and the worker logs
  for provider errors.
- Confirm Wikipedia is reachable (search returns 503 `SERVICE_UNAVAILABLE` when
  it is not).

---

## 8. Scaling notes

- **Throughput:** add worker containers. Work is claimed with
  `SELECT ... FOR UPDATE SKIP LOCKED`, so N containers scale linearly until the
  LLM provider rate-limits.
- **Database connections:** use Neon's pooled endpoint (`DATABASE_URL`) for the
  app/worker; reserve the direct endpoint (`DIRECT_URL`) for migrations.
- **SSE fan-out:** the stream polls Postgres every 2s per open connection. At
  high concurrency, consider Postgres `LISTEN/NOTIFY` (v2) before scaling SSE
  horizontally.
- **Rate limiting:** the in-memory token bucket is per-process. With more than
  one web instance, move it to Redis for a shared limit (v2).
- **Cost:** the per-user quota and global budget are enforced in the DB and
  remain correct across instances. Keep the monthly cap conservative and watch
  `GET /api/admin/cost`.

---

## Appendix A: Admin API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/admin/audit` | admin email or cron secret | Run the 14 invariant audits |
| GET | `/api/admin/cost` | admin email or cron secret | Budget + recent-run cost summary |
| POST | `/api/admin/kill-switch` | admin email or cron secret | Toggle `GlobalBudget.isPaused` |

Admin access requires the signed-in user's e-mail to appear in `ADMIN_EMAILS`
(case-insensitive). Cron requests bypass the user check via `CRON_SECRET`.

## Appendix B: Playwright smoke test

The smoke test is a **manual** pre-deployment check (live Wikipedia + LLM calls;
too slow/costly for CI).

```bash
pnpm exec playwright install chromium
pnpm run e2e                 # starts Next dev + the worker, then runs the journey
E2E_SKIP_WORKER=1 pnpm run e2e   # if you already run the worker yourself
```

It signs in via the test-only `POST /api/auth/test-login` (enabled only when
`NODE_ENV=test` or `E2E_TEST_AUTH=1`; Playwright sets the latter), searches,
creates a root node, expands upstream, and asserts that new nodes and an
evidence card appear.
