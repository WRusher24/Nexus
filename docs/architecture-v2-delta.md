# docs/architecture-v2-delta.md
# Nexus Architecture Amendments â€” v2 Delta
# Effective: Milestone 0
# Status: APPROVED
# Supersedes: Original blueprint sections as noted

## Preamble

This document records amendments to the original Nexus blueprint (Phase 2).
It does NOT replace the full blueprint. Read both together.
Where they conflict, this document wins.

---

## Amendment A1: Context-Free Extraction (fixes D1)

### What changed
The LLM extraction prompt no longer receives `ROOT_TOPIC`, `DEPTH`,
or the `DEPTH_PENALTY` conditional block. Extractions are universally
cacheable at key `(nodeId, direction)` regardless of the user's
exploration path.

### Drift prevention (moved to request gate)
- `Node.isRoot: Boolean @default(false)` â€” set `true` for nodes created
  via the search/disambiguation flow.
- Depth is computed server-side as the shortest upstream path from the
  target node to any root node in the current graph, via bounded
  recursive CTE (max depth 7).
- Expansion is blocked if computed depth > 6. The API returns
  `{ status: 'DEPTH_LIMIT_REACHED' }`.
- The prompt template removes these variables:
  `{{ROOT_TOPIC}}`, `{{DEPTH}}`, `{{#if DEPTH_PENALTY}}...{{/if}}`.

### Cache key
`(nodeId, direction)` â€” unchanged, but now correct because the
extraction is context-independent.

### Invariant
**INV-CACHE:** An extraction result for `(nodeId, direction)` is valid
for all users regardless of their exploration path.
Enforced by: absence of context-dependent variables in the prompt.
Tested by: golden test asserting prompt template contains no
session-specific variables.

---

## Amendment A2: Edge Uniqueness (fixes D2)

### What changed
Remove `@@unique([causeNodeId, effectNodeId, relationType, status])`
from the Drizzle schema.

Add raw SQL partial unique index:

```sql
CREATE UNIQUE INDEX unique_active_edge_pair
  ON "Edge" ("causeNodeId", "effectNodeId", "relationType")
  WHERE "status" = 'ACTIVE';

Semantics

    One ACTIVE edge per (cause, effect, relationType) triple.
    Multiple SUPERSEDED/REJECTED rows allowed for audit trail.
    Second extraction proposing the same edge attaches a new
    EvidenceSpan to the existing ACTIVE edge.

Amendment A3: Edge Insert Uses ON CONFLICT, Keeps SERIALIZABLE (fixes D3)
What changed

Edge inserts use ON CONFLICT DO NOTHING instead of try/catch:

SQL

INSERT INTO "Edge" (id, "causeNodeId", "effectNodeId", "relationType", status, ...)
VALUES (...)
ON CONFLICT ("causeNodeId", "effectNodeId", "relationType")
  WHERE status = 'ACTIVE'
DO NOTHING
RETURNING id;

If no row returned, the edge already exists â€” look it up and attach
new evidence.
Transaction isolation

Edge-insert-with-cycle-check transactions use SERIALIZABLE isolation.
A retry wrapper (max 3 attempts, jittered backoff 50-200ms) handles
serialization failures.
What we rejected

Global pg_advisory_xact_lock â€” serializes all edge writes
unnecessarily. At MVP scale, SERIALIZABLE retry rate will be <1%.
Amendment A4: Rejected Proposals Table (fixes D4)
What changed

Rejected edge proposals are stored in RejectedProposal, not in
Edge. The Edge table contains only edges that passed verification
(ACTIVE or SUPERSEDED).
New table

text

RejectedProposal
  id              UUID PK
  extractionRunId UUID FK â†’ ExtractionRun
  proposalData    JSONB  -- full proposed edge + evidence as-is from LLM
  rejectionReason TEXT   -- enum-like: QUOTE_NOT_FOUND | CHRONOLOGY_VIOLATION |
                         --   CYCLE_DETECTED | QUOTE_IRRELEVANT | SCHEMA_INVALID
  createdAt       TIMESTAMPTZ

  INDEX on extractionRunId

What was removed

EdgeStatus.REJECTED is removed from the enum. Edge.status is now
ACTIVE | SUPERSEDED. The REJECTED audit trail lives in
RejectedProposal.
Amendment A5: Quote Normalization with Index Map (fixes D5)
What changed

Quote verification uses a precomputed index map that tracks the
correspondence between positions in the normalized text and positions
in the original rawText.
Normalization rules (unchanged)

    Strip citation markers: [1], [12], [citation needed], etc.
    Unicode NFC normalization.
    Collapse all whitespace to single space.
    Trim.
    Lowercase (for matching only; original case preserved in stored quote).

Index map

NormalizedText { normalized: string; toOriginal: Int32Array }

    toOriginal[i] = the position in rawText that produced position
    i in the normalized text.
    Built once per SourceDocument, lazily on first extraction.
    Stored? No â€” recomputed from rawText as needed. It's deterministic
    and fast (~1ms for a 50KB article).

Chunk boundary enforcement

A verified quote must fall within a section that was included in the
chunks sent to the LLM (recorded in ExtractionRun.chunksUsed). If
the quote matches text outside the sent chunks, reject with
QUOTE_OUTSIDE_CONTEXT.
Multiple matches

Use the first match (by position) that falls within a sent chunk.
Amendment A6: Interval-Based Chronology (fixes D6)
What changed

Date comparison uses earliest/latest year intervals derived from
precision, not raw year comparison.
Interval computation
Precision	Interval
DAY/MONTH/YEAR	[year, year]
DECADE	[year, year+9]
CENTURY	[year, year+99]
MILLENNIUM	[year, year+999]
UNKNOWN	null (skip check)
Rejection rule

Reject edge only if cause.earliest > effect.latest.
Otherwise, chronologyStatus = 'VERIFIED' if both intervals exist and
cause could precede effect, or 'UNVERIFIED' if either is null.
Use stored dates

When the related entity already exists in the DB, use its stored dates
for the chronology check, not the LLM's restated dates.
Amendment A7: Entity-Mention Check + Deferred Constraint Trigger (fixes D7)
Entity-mention check

The quote must contain at least one of:

    A 4+ character substring of the cause entity's name (normalized), OR
    A 4+ character substring of the effect entity's name (normalized)

If neither is found, reject with QUOTE_IRRELEVANT.

This is a low-bar sanity check, not entailment verification.
Deferred constraint trigger

Enforces P3 at the database level:

SQL

CREATE OR REPLACE FUNCTION check_edge_has_evidence()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'ACTIVE' AND NOT EXISTS (
    SELECT 1 FROM "EvidenceSpan"
    WHERE "edgeId" = NEW.id
      AND "verificationStatus" = 'VERIFIED'
  ) THEN
    RAISE EXCEPTION 'P3 VIOLATION: ACTIVE edge % has no verified evidence', NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_edge_evidence
  AFTER INSERT OR UPDATE ON "Edge"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION check_edge_has_evidence();

This is defense-in-depth. The application write path
(insertVerifiedEdge) is still the primary enforcement.
Amendment A8: State Machine Fixes (fixes D8)
Single transition function

All state changes go through transitionExpansion(requestId, fromStatus, toStatus, updates) which atomically updates
ExpansionRequest.status and the corresponding
Node.upstreamState/Node.downstreamState in one transaction.

The WHERE status = $fromStatus clause provides an optimistic lock â€”
if another process already transitioned the request, the UPDATE
affects zero rows and the caller knows to re-read.
Attempt counting

Only the worker increments attempt (on claim). The lease reaper
does NOT increment attempt. It sets status = PENDING and clears
lease fields.
Heartbeat

During long-running operations (LLM calls), the worker extends the
lease every 30 seconds via:

SQL

UPDATE "ExpansionRequest"
SET "leaseExpiresAt" = NOW() + INTERVAL '90 seconds'
WHERE id = $id AND "lockedBy" = $workerId;

This runs in a setInterval that is cleared when the operation
completes.
Schema addition

retryAfter DateTime? added to ExpansionRequest.
Workers skip requests where retryAfter > NOW().
Amendment A9: Pre-Reserve Cost (fixes D9)
ExtractionRun created before LLM call

The ExtractionRun is created with status = PENDING before the
LLM call, with estimatedCostUsd based on input token count.
Atomic budget reservation

SQL

UPDATE "GlobalBudget"
SET "spentTodayUsd" = "spentTodayUsd" + $estimated
WHERE id = 'singleton'
  AND "spentTodayUsd" + $estimated <= "dailyBudgetUsd"
  AND "spentThisMonthUsd" + $estimated <= "monthlyBudgetUsd"
  AND "isPaused" = false
RETURNING *;

If zero rows returned â†’ budget exceeded â†’ abort expansion â†’
release user quota charge â†’ set request to FAILED.

On completion: reconcile estimatedCostUsd with actual.
On failure: release the reserved amount.
User quota

Same atomic pattern:

SQL

UPDATE "UserQuota"
SET "expansionsToday" = "expansionsToday" + 1,
    "expansionsThisMonth" = "expansionsThisMonth" + 1
WHERE "userId" = $userId
  AND "expansionsToday" < "dailyLimit"
  AND "expansionsThisMonth" < "monthlyLimit"
RETURNING *;

Amendment A10: Server-Side Depth Computation (fixes D10)
What changed

depthFromRoot is no longer a client parameter. It is computed
server-side.
Mechanism

    Node.isRoot Boolean @default(false) added.
    Nodes created via search/disambiguation are isRoot = true.
    Depth = shortest upstream path to any isRoot node:

SQL

WITH RECURSIVE upstream AS (
  SELECT $nodeId::uuid AS "nodeId", 0 AS depth
  UNION ALL
  SELECT e."causeNodeId", u.depth + 1
  FROM "Edge" e
  JOIN upstream u ON e."effectNodeId" = u."nodeId"
  WHERE e.status = 'ACTIVE' AND u.depth < 7
)
SELECT COALESCE(MIN(u.depth), 999) AS min_depth
FROM upstream u
JOIN "Node" n ON u."nodeId" = n.id
WHERE n."isRoot" = true;

    If min_depth > 6, expansion is blocked.
    If no root is reachable (orphan subgraph), min_depth = 999 â†’
    blocked. This shouldn't happen in normal flow.
    Computed depth is stored on ExpansionRequest.depthFromRoot
    for logging.

Amendment A11: SourceDocument Decoupled from Node (fixes D11)
SourceDocument keyed by page + revision

text

SourceDocument
  ...
  -- remove: nodeId
  -- add unique constraint:
  @@unique([wikipediaPageId, revisionId])

The relationship Node â†” SourceDocument is indirect:
Node â† ExtractionRun.focalNodeId and
ExtractionRun.sourceDocumentId â†’ SourceDocument.

Multiple nodes can share a SourceDocument if they reference the
same Wikipedia page.
Drop calendarEra

Removed from Node. Negative dateStartYear means BCE. Convention
documented in AGENTS.md.
Direction enum

text

enum Direction { UPSTREAM, DOWNSTREAM }

Used on ExpansionRequest.direction and ExtractionRun.direction.
Amendment A12: Provider-Specific JSON Schema (non-blocking, M5/M6)

Zod types are the canonical schema definition. JSON Schema is
generated per-provider by an adapter. Strict-mode restrictions
(no maxLength, no type unions) are handled in the adapter, not
in the schema definition.

No schema changes needed now.
Topology Amendment: Worker Process
Architecture

text

â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”     â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚  Vercel / Container     â”‚     â”‚  Container (Railway/   â”‚
â”‚  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”  â”‚     â”‚  Render / VPS)         â”‚
â”‚  â”‚  Next.js App      â”‚  â”‚     â”‚  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”   â”‚
â”‚  â”‚  (App Router)     â”‚  â”‚     â”‚  â”‚  worker.ts       â”‚   â”‚
â”‚  â”‚  - API routes     â”‚  â”‚     â”‚  â”‚  - poll loop     â”‚   â”‚
â”‚  â”‚  - SSE endpoints  â”‚  â”‚     â”‚  â”‚  - LLM calls     â”‚   â”‚
â”‚  â”‚  - React frontend â”‚  â”‚     â”‚  â”‚  - validation    â”‚   â”‚
â”‚  â””â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜  â”‚     â”‚  â”‚  - graph writes  â”‚   â”‚
â”‚           â”‚              â”‚     â”‚  â””â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜  â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜     â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
            â”‚                                â”‚
            â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                         â”‚
                  â”Œâ”€â”€â”€â”€â”€â”€â–¼â”€â”€â”€â”€â”€â”€â”
                  â”‚ Neon        â”‚
                  â”‚ PostgreSQL  â”‚
                  â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜

Rationale

    Next.js on Vercel (or a container) handles HTTP: API routes,
    SSE streams, and the React frontend.
    worker.ts runs as a separate long-lived process on a container
    host. It polls the ExpansionRequest table, claims work via
    SELECT FOR UPDATE SKIP LOCKED, runs the full extraction +
    validation pipeline, and writes results.
    Both connect to the same Neon PostgreSQL instance.
    The worker MUST NOT run inside the Next.js process (Vercel
    serverless timeout, Next.js hot-reload kills long-running work).

Communication

    API â†’ Worker: indirect, via ExpansionRequest rows in the database.
    No direct RPC. No message broker for MVP.
    Worker â†’ API/Frontend: indirect, via database state. The SSE
    endpoint polls ExpansionRequest.status every 2 seconds.
    If polling becomes a problem at scale, add Postgres
    LISTEN/NOTIFY for push notification. v2.

ORM Change: Prisma â†’ Drizzle
Rationale

The project requires 8 PostgreSQL-native features (advisory locks,
partial indexes, CHECK constraints, constraint triggers, recursive
CTEs, ON CONFLICT DO NOTHING RETURNING, SELECT FOR UPDATE SKIP LOCKED,
per-transaction isolation levels). With Prisma, 6 of 8 require
stringly-typed $queryRaw. Drizzle's SQL-first approach makes these
first-class or natural.
Migration workflow

    Schema defined in TypeScript using drizzle-orm/pg-core.
    drizzle-kit generate produces .sql migration files.
    Custom SQL (constraint triggers, partial indexes, CHECKs) is
    appended to generated migrations or added as separate migration
    files.
    drizzle-kit push for dev, drizzle-kit migrate for production.

Agent guidance

Builder agents must consult the installed drizzle-orm type
definitions for API verification. Drizzle examples are provided
in AGENTS.md.
Updated Schema Summary (Drizzle)

Key changes from blueprint:

    ORM: Prisma â†’ Drizzle (pg-core).
    Edge.status: ACTIVE | SUPERSEDED only (no REJECTED).
    New table: RejectedProposal.
    SourceDocument: remove nodeId, add @@unique(pageId, revisionId).
    Node: add isRoot, remove calendarEra.
    ExpansionRequest: add retryAfter, direction is enum.
    ExtractionRun: direction is enum, created before LLM call.
    New enum: Direction.
    Partial unique index on Edge replaces Prisma @@unique.
    Deferred constraint trigger for P3.
