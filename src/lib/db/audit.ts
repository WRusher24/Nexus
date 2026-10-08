import { config } from 'dotenv';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

// Load local env for dev. In CI, DATABASE_URL comes from the workflow
// environment and a missing .env.local is fine (dotenv never overrides an
// already-set variable).
config({ path: '.env.local' });

/**
 * Runs one audit's SQL and returns the rows. Implementations adapt their driver
 * (pg Pool for the CLI, Drizzle `.execute` for the admin route) to this shape.
 */
export type AuditQueryRunner = (
  sqlText: string,
) => Promise<Array<Record<string, unknown>>>;

export interface AuditDefinition {
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

/** Result of evaluating one audit. `name` is prefixed with "Audit ". */
export interface AuditResult {
  name: string;
  violations: number;
  pass: boolean;
}

const AUDITS: AuditDefinition[] = [
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
  {
    label: '8 (Queue): No in-flight expansion requests without a node',
    kind: 'count',
    sql: `SELECT COUNT(*)::int AS violations
          FROM "expansionRequests" r
          WHERE r.status IN ('PENDING', 'LOCKED', 'FETCHING', 'EXTRACTING', 'VALIDATING')
            AND NOT EXISTS (
              SELECT 1 FROM "nodes" n WHERE n.id = r."nodeId"
            )`,
  },
  {
    label: '9 (Queue): No LOADING nodes without an in-flight request',
    kind: 'count',
    sql: `SELECT COUNT(*)::int AS violations
          FROM "nodes" n
          WHERE (n."upstreamState" = 'LOADING' OR n."downstreamState" = 'LOADING')
            AND NOT EXISTS (
              SELECT 1 FROM "expansionRequests" r
              WHERE r."nodeId" = n.id
                AND r.status IN ('LOCKED', 'FETCHING', 'EXTRACTING', 'VALIDATING')
            )`,
  },
  {
    label: '10 (Queue): No leases stale for more than 5 minutes',
    kind: 'count',
    sql: `SELECT COUNT(*)::int AS violations
          FROM "expansionRequests"
          WHERE "status" IN ('LOCKED', 'FETCHING', 'EXTRACTING', 'VALIDATING')
            AND "leaseExpiresAt" < NOW() - INTERVAL '5 minutes'`,
  },
  {
    label: '11 (P6): No users over their monthly expansion limit',
    kind: 'rows',
    sql: `SELECT "userId", "expansionsThisMonth", "monthlyLimit"
          FROM "userQuotas"
          WHERE "expansionsThisMonth" > "monthlyLimit"`,
  },
  {
    label: '12 (P6): No global budget overrun',
    kind: 'rows',
    sql: `SELECT "id", "spentTodayUsd", "dailyBudgetUsd",
                 "spentThisMonthUsd", "monthlyBudgetUsd"
          FROM "globalBudget"
          WHERE "spentTodayUsd" > "dailyBudgetUsd"
             OR "spentThisMonthUsd" > "monthlyBudgetUsd"`,
  },
  {
    // Auto-hide is the only feedback-driven way an edge leaves ACTIVE, and it
    // must never fire with fewer than two distinct INCORRECT reporters. Edges
    // SUPERSEDED by other means (e.g. node merge) carry no INCORRECT feedback
    // and are therefore not candidates here.
    label:
      '13 (Feedback): SUPERSEDED edges have >= 2 distinct INCORRECT reporters',
    kind: 'rows',
    sql: `SELECT e."id", COUNT(DISTINCT f."userId") AS reporters
          FROM "edges" e
          JOIN "edgeFeedback" f
            ON f."edgeId" = e."id" AND f."type" = 'INCORRECT'
          WHERE e."status" = 'SUPERSEDED'
          GROUP BY e."id"
          HAVING COUNT(DISTINCT f."userId") < 2`,
  },
  {
    label: '14 (Users): All userId references resolve to a users row',
    kind: 'rows',
    sql: `SELECT 'userQuotas' AS source, q."userId" AS "userId"
          FROM "userQuotas" q
          LEFT JOIN "users" u ON u."id" = q."userId"
          WHERE u."id" IS NULL
          UNION ALL
          SELECT 'edgeFeedback', f."userId"
          FROM "edgeFeedback" f
          LEFT JOIN "users" u ON u."id" = f."userId"
          WHERE u."id" IS NULL
          UNION ALL
          SELECT 'expansionRequests', r."requestedBy"
          FROM "expansionRequests" r
          LEFT JOIN "users" u ON u."id" = r."requestedBy"
          WHERE r."requestedBy" IS NOT NULL AND u."id" IS NULL`,
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

/**
 * Evaluate every audit against a query runner. Shared by the CLI (`main`) and
 * the `GET /api/admin/audit` route so both report exactly the same result set.
 */
export async function runInvariantAudit(
  runner: AuditQueryRunner,
): Promise<AuditResult[]> {
  const results: AuditResult[] = [];
  for (const audit of AUDITS) {
    const rows = await runner(audit.sql);
    const violations =
      audit.kind === 'count' ? Number(rows[0]?.violations ?? 0) : rows.length;
    results.push({
      name: `Audit ${audit.label}`,
      violations,
      pass: violations === 0,
    });
  }
  return results;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: resolveDatabaseUrl() });

  console.log('Nexus Invariant Audit');
  console.log('=====================');

  try {
    const results = await runInvariantAudit(async (sqlText) => {
      const result = await pool.query<Record<string, unknown>>(sqlText);
      return result.rows;
    });

    let passed = 0;
    for (const result of results) {
      if (result.pass) passed += 1;
      const status = result.pass ? 'PASS' : 'FAIL';
      console.log(
        `[${status}] ${result.name} (${result.violations} violations)`,
      );
    }

    console.log('=====================');
    console.log(`Result: ${passed}/${results.length} passed`);

    if (passed !== results.length) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

// Only run the CLI when this module is executed directly (not when imported by
// the admin route). `import.meta.url` is compared against the resolved argv[1].
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
