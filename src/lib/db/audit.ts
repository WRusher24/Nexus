import { config } from 'dotenv';
import { Pool } from 'pg';

// Load local env for dev. In CI, DATABASE_URL comes from the workflow
// environment and a missing .env.local is fine (dotenv never overrides an
// already-set variable).
config({ path: '.env.local' });

interface Audit {
  /** Human-readable label, e.g. "1 (P1): No identity-less nodes". */
  label: string;
  /** SQL that returns either a single COUNT row or the violating rows. */
  sql: string;
  /**
   * How to interpret the result. `count` expects a single integer column;
   * `rows` counts the returned rows.
   */
  kind: 'count' | 'rows';
}

const AUDITS: Audit[] = [
  {
    label: '1 (P1): No identity-less nodes',
    kind: 'count',
    sql: `SELECT COUNT(*)::int AS violations
          FROM "nodes"
          WHERE "wikidataQid" IS NULL
            AND "wikipediaPageId" IS NULL
            AND "nexusGeneratedId" IS NULL`,
  },
  {
    label: '2 (P1): No duplicate QIDs',
    kind: 'rows',
    sql: `SELECT "wikidataQid", COUNT(*) AS count
          FROM "nodes"
          WHERE "wikidataQid" IS NOT NULL
          GROUP BY "wikidataQid"
          HAVING COUNT(*) > 1`,
  },
  {
    label: '3 (P2): No self-referential edges',
    kind: 'count',
    sql: `SELECT COUNT(*)::int AS violations
          FROM "edges"
          WHERE "causeNodeId" = "effectNodeId"`,
  },
  {
    label: '4 (P2): No cycles in the active edge graph',
    kind: 'count',
    // NOTE (deviation from the M2 brief): the brief's recursive CTE excludes
    // any node already present in the path, which also excludes the edge that
    // closes a cycle. That version only ever detects self-loops. The WHERE
    // clause here allows the single step back to the chain's start node (so a
    // cycle can actually be closed) while still pruning revisits of
    // intermediate nodes to bound the search. Self-loops are also caught by
    // chk_no_self_edge at write time.
    sql: `WITH RECURSIVE chain AS (
            SELECT
              "causeNodeId" AS start,
              "effectNodeId" AS current,
              ARRAY["causeNodeId", "effectNodeId"] AS path,
              1 AS depth
            FROM "edges"
            WHERE "status" = 'ACTIVE'
            UNION ALL
            SELECT
              c.start,
              e."effectNodeId",
              c.path || e."effectNodeId",
              c.depth + 1
            FROM chain c
            JOIN "edges" e
              ON e."causeNodeId" = c.current
             AND e."status" = 'ACTIVE'
            WHERE c.depth < 50
              AND (
                e."effectNodeId" = c.start
                OR NOT (e."effectNodeId" = ANY(c.path))
              )
          )
          SELECT COUNT(*)::int AS violations
          FROM chain
          WHERE current = start`,
  },
  {
    label: '5 (P3): No active edges without verified evidence',
    kind: 'count',
    sql: `SELECT COUNT(*)::int AS violations
          FROM "edges" e
          WHERE e."status" = 'ACTIVE'
            AND NOT EXISTS (
              SELECT 1
              FROM "evidenceSpans" es
              WHERE es."edgeId" = e."id"
                AND es."verificationStatus" = 'VERIFIED'
            )`,
  },
  {
    label: '6 (P2): No active edges with out-of-bounds importance rank',
    kind: 'count',
    sql: `SELECT COUNT(*)::int AS violations
          FROM "edges"
          WHERE "status" = 'ACTIVE'
            AND ("importanceRank" < 1 OR "importanceRank" > 10)`,
  },
  {
    label: '7 (P1): No duplicate active edges',
    kind: 'rows',
    sql: `SELECT "causeNodeId", "effectNodeId", "relationType", COUNT(*) AS count
          FROM "edges"
          WHERE "status" = 'ACTIVE'
          GROUP BY "causeNodeId", "effectNodeId", "relationType"
          HAVING COUNT(*) > 1`,
  },
];

function resolveDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.DIRECT_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env.local, or export it in the environment.',
    );
  }
  return url;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: resolveDatabaseUrl() });

  console.log('Nexus Invariant Audit');
  console.log('=====================');

  let passed = 0;

  try {
    for (const audit of AUDITS) {
      const result = await pool.query<{ violations?: number }>(audit.sql);
      const violations =
        audit.kind === 'count' ? (result.rows[0]?.violations ?? 0) : result.rows.length;
      const ok = violations === 0;
      if (ok) {
        passed += 1;
      }
      const status = ok ? 'PASS' : 'FAIL';
      console.log(`[${status}] Audit ${audit.label} (${violations} violations)`);
    }
  } finally {
    await pool.end();
  }

  console.log('=====================');
  console.log(`Result: ${passed}/${AUDITS.length} passed`);

  if (passed !== AUDITS.length) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
