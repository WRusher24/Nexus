# Project Status

## Current milestone: 1 (Scaffold)

## Last session: 2026-10-08

## State: Scaffold created, CI green, no schema or logic yet.

## Next: Milestone 2 (Data model and DB invariants)

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
