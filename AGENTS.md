# AGENTS.md

# Nexus Project — Agent Operating Manual

# Last updated: 2026-10-08

# Binding on all agents (human or AI) writing code in this repo.

## Project summary

Nexus is a web app for learning history through an interactive causal
graph, grown lazily from Wikipedia via LLM extraction. See
`docs/architecture-v2-delta.md` (amendments) and the original blueprint
in `docs/architecture-v1-blueprint.md` (baseline).

Where they conflict, the delta document wins.

## Invariants (NEVER violate)

These are the system's non-negotiable properties. Every invariant has
a specific enforcement mechanism. If your code change could affect an
invariant, you must verify the enforcement still holds.

### P1: Canonical Identity

Every historical entity resolves to exactly ONE database row.

- **Primary key:** Wikidata QID (unique constraint on `Node.wikidataQid`).
- **Fallback:** `wikipediaPageId` (unique when QID is null),
  then `nexusGeneratedId` (unique, marked UNRESOLVED).
- **CHECK constraint:** at least one identity field is non-null.
- **Enforcement:** Upsert-by-QID in all write paths. Unique constraints
  in DB. `INSERT ... ON CONFLICT DO NOTHING RETURNING` pattern.
- **Test:** concurrent inserts of same QID → exactly 1 row.

### P2: Acyclicity (DAG)

The causal graph must be a directed acyclic graph.

- **Enforcement:** Recursive CTE cycle check inside a SERIALIZABLE
  transaction at edge insert time. Self-edge CHECK constraint.
- **Chronology:** Interval-based. Reject if `cause.earliest > effect.latest`.
- **Feedback loops:** Decomposed into temporal phases (separate nodes).
- **Test:** insert A→B then B→A → second is rejected.

### P3: Evidence Constraint

Every ACTIVE edge must have ≥1 VERIFIED evidence span with a verbatim
quote located in the pinned source text.

- **Primary enforcement:** `insertVerifiedEdge()` — the ONLY function
  that may insert into the Edge table.
- **DB enforcement:** Deferred constraint trigger
  `trg_edge_evidence` raises exception at commit if violated.
- **Audit:** `pnpm run audit:invariants` includes a query that finds
  ACTIVE edges without verified evidence (should return 0 rows).
- **Test:** raw SQL insert of edge without evidence → transaction
  aborted by trigger.

### P4: Persist-Once, Version Everything

- ExtractionRuns are append-only. Never UPDATE an ExtractionRun's
  raw output or results.
- Re-extraction creates a new run. Old edges get `SUPERSEDED`.
- Never DELETE from Edge, EvidenceSpan, ExtractionRun, SourceDocument,
  or RejectedProposal.
- **Enforcement:** Application convention. No DELETE operations in
  application code (lint rule).

### P5: Untrusted Inputs

- Wikipedia text inside `<source_text>` delimiters with anti-injection
  instructions.
- LLM output validated by Zod, then quote-verified, before any DB write.
- **Enforcement:** Validation pipeline runs before `insertVerifiedEdge`.

### P6: Cost and Abuse Control

- Per-user quota: atomic conditional UPDATE (not read-then-write).
- Global budget: atomic conditional UPDATE with pre-reservation.
- Depth limit: server-side computation, max 6 from nearest root.
- Max 12 edges per extraction.
- **Enforcement:** Request gate + atomic budget reservation.

---

## Tech Stack (pinned)

| Component       | Choice                    | Version       |
| --------------- | ------------------------- | ------------- |
| Runtime         | Node.js                   | 20 LTS        |
| Language        | TypeScript                | 5.x, strict   |
| Framework       | Next.js (App Router)      | 15.x          |
| ORM             | Drizzle ORM               | latest stable |
| Database        | PostgreSQL (Neon)         | 16            |
| Migrations      | drizzle-kit               | latest        |
| Test framework  | Vitest                    | latest        |
| E2E tests       | Playwright                | latest        |
| Package manager | pnpm                      | latest        |
| Graph rendering | React Flow + ELK          |               |
| Auth            | Auth.js                   |               |
| Validation      | Zod                       |               |
| CI              | GitHub Actions            |               |

---

## Forbidden list

These are lint-enforced or review-enforced bans:

1. **No `any` type.** Use `unknown` and narrow.
2. **No `@ts-ignore` or `@ts-expect-error`.** Fix the type.
3. **No direct Edge table inserts** outside `insertVerifiedEdge()`.
   Custom ESLint rule bans `db.insert(edges)` outside
   `src/lib/graph/insertVerifiedEdge.ts`.
4. **No mocking the database** in invariant tests. Use a real
   Postgres instance (Neon branch or Docker in CI).
5. **No live LLM calls** in tests. Use recorded fixtures
   (`src/test/fixtures/llm/`).
6. **No deleting or weakening a test** to make it pass.
7. **No editing an applied migration.** Create a new migration.
8. **No new dependency** without a one-line justification in
   the PR description.
9. **No DELETE statements** in application code (P4).
10. **No client-supplied `depthFromRoot`.**

---

## Repository Structure

```
nexus/
├── .github/
│   └── workflows/
│       └── ci.yml                        # GitHub Actions: lint, typecheck, test
├── docs/
│   ├── architecture-v1-blueprint.md
│   ├── architecture.md
│   ├── architecture-v2-delta.md
│   ├── adr/                              # Architecture Decision Records
│   │   └── 001-drizzle-over-prisma.md
│   └── STATUS.md                         # Updated at end of every session
├── src/
│   ├── app/                              # Next.js App Router
│   │   ├── api/                          # API routes
│   │   └── (frontend)/                   # React pages (M9)
│   ├── lib/
│   │   ├── db/
│   │   │   ├── schema.ts                 # Drizzle schema
│   │   │   ├── migrations/               # Generated + custom SQL
│   │   │   ├── client.ts                 # Drizzle client setup
│   │   │   └── audit.ts                  # Invariant audit queries
│   │   ├── graph/
│   │   │   ├── upsertNode.ts
│   │   │   ├── insertVerifiedEdge.ts     # THE edge write path
│   │   │   ├── cycleCheck.ts
│   │   │   └── traversal.ts
│   │   ├── extraction/
│   │   │   ├── prompt.ts                 # Versioned prompt template
│   │   │   ├── schema.ts                 # Zod types for LLM output
│   │   │   ├── validate.ts               # Post-extraction pipeline
│   │   │   └── provider.ts               # LLM provider abstraction
│   │   ├── wikipedia/
│   │   │   ├── client.ts                 # Wikipedia API client
│   │   │   ├── wikidata.ts               # Wikidata QID resolver
│   │   │   └── chunker.ts                # Section-aware chunking
│   │   ├── quote/
│   │   │   ├── normalize.ts              # Normalization + index map
│   │   │   └── verify.ts                 # Quote location + verification
│   │   ├── dates/
│   │   │   ├── intervals.ts              # Date → interval conversion
│   │   │   └── chronology.ts             # Chronology comparison
│   │   └── queue/
│   │       ├── transition.ts             # State machine transitions
│   │       ├── claim.ts                  # SELECT FOR UPDATE SKIP LOCKED
│   │       └── reaper.ts                 # Lease expiry handler
│   ├── worker/
│   │   ├── index.ts                      # Worker entry point (poll loop)
│   │   └── processExpansion.ts           # Main worker logic
│   └── test/
│       ├── fixtures/
│       │   ├── llm/                      # Recorded LLM responses
│       │   ├── wikipedia/                # Recorded Wikipedia responses
│       │   └── sources/                  # Sample source texts
│       ├── helpers/
│       │   ├── db.ts                     # Test DB setup/teardown
│       │   └── setup.ts                  # Vitest setup (loads dotenv)
│       ├── invariants/                   # P1-P6 invariant tests
│       ├── unit/                         # Pure logic tests
│       └── integration/                  # DB-backed tests
├── drizzle.config.ts
├── vitest.config.ts
├── tsconfig.json
├── package.json
├── pnpm-lock.yaml
├── .env.example
├── .env.local                            # NEVER committed
├── .eslintrc.cjs                         # Includes custom rules
├── AGENTS.md                             # THIS FILE
└── CLAUDE.md                             # → points to AGENTS.md
```

> Files under `src/lib/graph/`, `src/lib/extraction/`, `src/lib/wikipedia/`,
> `src/lib/quote/`, `src/lib/dates/`, `src/lib/queue/`, and
> `src/worker/processExpansion.ts` are introduced in later milestones. The
> structure above is the target shape from AGENTS.md.

---

## Agent session protocol

### Starting a session

1. Read `AGENTS.md` (this file).
2. Read `docs/STATUS.md` for current state.
3. Read the task prompt for scope boundaries.

### Ending a session

1. Update `docs/STATUS.md` with:
   - What was completed
   - What tests pass/fail
   - Any deviations from the task
   - `pnpm run audit:invariants` output
2. Commit with a descriptive message.

### Task prompt template

Every task given to a builder agent uses this structure:

- Goal: [One sentence]
- Files to read first: [List]
- Files allowed to change: [List — agent must NOT touch other files]
- Acceptance criteria: [List of tests that must exist and pass]
- Out of scope: [Explicit list]
- Report format: Files changed (with one-line summary each), Tests added
  (with names), Test output (paste), `pnpm run audit:invariants` output,
  Deviations from this task (if any — explain why).

### When to stop and ask

- Requirement is ambiguous
- Task conflicts with an ADR or invariant
- Scope exceeds what was specified
- A library API doesn't match docs or types
- A test must be weakened to pass

---

## Drizzle ORM patterns (for builder agents)

### Transaction with isolation level

```typescript
await db.transaction(
  async (tx) => {
    // ... your operations
  },
  { isolationLevel: 'serializable' },
);
```

### SELECT FOR UPDATE SKIP LOCKED

```typescript
const [job] = await tx
  .select()
  .from(expansionRequests)
  .where(eq(expansionRequests.status, 'PENDING'))
  .orderBy(expansionRequests.requestedAt)
  .limit(1)
  .for('update', { skipLocked: true });
```

### ON CONFLICT DO NOTHING

```typescript
const result = await tx
  .insert(nodes)
  .values({ /* ... */ })
  .onConflictDoNothing({ target: nodes.wikidataQid })
  .returning({ id: nodes.id });

if (result.length === 0) {
  // Already exists — look it up
  const [existing] = await tx
    .select()
    .from(nodes)
    .where(eq(nodes.wikidataQid, qid));
}
```

### Raw SQL for advisory locks

```typescript
await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey})`);
```

### Raw SQL for recursive CTE

```typescript
const result = await tx.execute(sql`
  WITH RECURSIVE ancestors AS (
    SELECT "causeNodeId" AS "nodeId", 1 AS depth
    FROM "Edge"
    WHERE "effectNodeId" = ${nodeId} AND status = 'ACTIVE'
    UNION ALL
    SELECT e."causeNodeId", a.depth + 1
    FROM "Edge" e
    JOIN ancestors a ON e."effectNodeId" = a."nodeId"
    WHERE e.status = 'ACTIVE' AND a.depth < 50
  )
  SELECT EXISTS (
    SELECT 1 FROM ancestors WHERE "nodeId" = ${targetId}
  ) AS "wouldCycle"
`);
```

---

## Wikipedia API etiquette

- `User-Agent: Nexus/1.0 (${CONTACT_EMAIL}) nexus-history-graph`
- Max 200 requests/second (we'll never approach this).
- Cache responses by revision ID (immutable).
- Use TextExtracts API with `exintro=false&explaintext=true` for plain text.
- Use Wikidata API for QID resolution with `wbsearchentities`.

---

## Date convention

- Negative year = BCE. Year -44 = 44 BCE.
- No `calendarEra` field. Convention only.
- `UNKNOWN` precision = no date information. Year may be null.

---

## Prompt versioning

- Prompt template lives in `src/lib/extraction/prompt.ts`.
- Exported constant `PROMPT_VERSION = '1.0.0'` (semver).
- Any change to the prompt text bumps the version.
- Version is recorded on every ExtractionRun.
- Golden tests in `src/test/unit/extraction/` assert on specific
  prompt versions. Changing the prompt requires updating golden tests.
