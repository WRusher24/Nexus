# Project Status

## Current milestone: 3 (Deterministic logic & parsing core)

## Last session: 2026-10-08

## State: Quote normalization + verification, date interval algebra, chronology comparator, Zod extraction schemas (enum-parity guarded), and section-aware chunking — all pure, with fast-check property tests. `pnpm run verify` green (147 tests).

## Next: Milestone 4 (insertVerifiedEdge + cycle check + upsertNode)

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
