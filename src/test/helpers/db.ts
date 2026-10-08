import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import * as schema from '../../lib/db/schema';

/**
 * Test database utilities.
 *
 * These tests run against a real PostgreSQL instance (local Docker / local
 * service in dev, the `postgres` service in GitHub Actions). We never mock the
 * database: the whole point of the invariant suite is to prove that the real
 * constraints, partial indexes, and deferred trigger reject bad data.
 */

/** Drizzle database handle plus the underlying pool. */
export interface TestDb {
  db: NodePgDatabase<typeof schema>;
  pool: Pool;
  /** Dedicated client that holds a cross-process advisory lock. */
  lockClient: Client;
}

/**
 * Arbitrary, stable key for the session-level advisory lock. Holding it for the
 * lifetime of a test file serialises the test files against each other, because
 * Vitest runs files in parallel worker processes and they all share one
 * database. Without this, two files could truncate each other's fixtures.
 */
const DB_LOCK_KEY = 982451653;

const MIGRATIONS_FOLDER = fileURLToPath(
  new URL('../../lib/db/migrations', import.meta.url),
);

export function getTestDatabaseUrl(): string {
  const url =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    process.env.DIRECT_URL;
  if (!url) {
    throw new Error(
      'No test database configured. Set DATABASE_URL (see .env.example).',
    );
  }
  return url;
}

/**
 * Create a fresh test database handle and apply all migrations (the
 * Drizzle-generated SQL and the custom CHECKs / partial indexes / deferred
 * trigger / seed appended to it).
 *
 * Migrations are applied under a session advisory lock so that parallel test
 * files cannot race on the `drizzle.__drizzle_migrations` bookkeeping table.
 */
export async function getTestDb(): Promise<TestDb> {
  const url = getTestDatabaseUrl();
  const pool = new Pool({ connectionString: url, max: 10 });
  const db = drizzle(pool, { schema });

  const lockClient = new Client({ connectionString: url });
  await lockClient.connect();
  await lockClient.query('SELECT pg_advisory_lock($1)', [DB_LOCK_KEY]);

  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } catch (error) {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [DB_LOCK_KEY]);
    await lockClient.end();
    await pool.end();
    throw error;
  }

  return { db, pool, lockClient };
}

const ALL_TABLES = [
  'edgeFeedback',
  'evidenceSpans',
  'rejectedProposals',
  'edges',
  'expansionRequests',
  'extractionRuns',
  'sourceDocuments',
  'qidReconciliations',
  'nodes',
  'userQuotas',
  'globalBudget',
] as const;

/**
 * Truncate every table between tests.
 *
 * TRUNCATE does not fire row-level triggers, so the deferred P3 constraint
 * trigger (`trg_edge_evidence`) is not invoked by this reset — no explicit
 * DISABLE TRIGGER dance is required. All tables are listed and CASCADE is used,
 * so foreign-key ordering is irrelevant. The global budget singleton is
 * re-seeded afterwards because the seed row is removed by the truncate.
 */
export async function resetTestDb(testDb: TestDb): Promise<void> {
  const tableList = sql.raw(
    ALL_TABLES.map((table) => `"${table}"`).join(', '),
  );
  await testDb.db.execute(sql`TRUNCATE TABLE ${tableList} CASCADE`);
  await testDb.db.execute(sql`
    INSERT INTO "globalBudget"
      ("id", "dailyBudgetUsd", "monthlyBudgetUsd", "spentTodayUsd", "spentThisMonthUsd", "currentDay", "currentMonth", "isPaused", "updatedAt")
    VALUES ('singleton', 50, 500, 0, 0, CURRENT_DATE, CURRENT_DATE, false, NOW())
    ON CONFLICT ("id") DO NOTHING
  `);
}

/** Release the advisory lock and close the pool. */
export async function closeTestDb(testDb: TestDb): Promise<void> {
  try {
    await testDb.lockClient.query('SELECT pg_advisory_unlock($1)', [DB_LOCK_KEY]);
  } finally {
    await testDb.lockClient.end();
    await testDb.pool.end();
  }
}

/**
 * Extract a PostgreSQL SQLSTATE error code from an unknown error, unwrapping
 * Drizzle's `DrizzleQueryError` wrapper (which nests the driver error under
 * `cause`).
 */
export function getPgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === 'object' && 'code' in current) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string') {
        return code;
      }
    }
    if (typeof current === 'object' && 'cause' in current) {
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return undefined;
}

/**
 * Run `fn`, returning the thrown error (or `undefined` if it resolved). Lets
 * tests assert on the SQLSTATE of a rejected statement without `try/catch`
 * noise in every test.
 */
export async function captureError(
  fn: () => Promise<unknown>,
): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

/**
 * Join the messages of an error and its `cause` chain. Drizzle wraps driver
 * errors, so the human-readable PostgreSQL message (e.g. a RAISE EXCEPTION
 * text) lives on a nested cause rather than the top-level error.
 */
export function errorChainMessage(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message);
    } else if (typeof current === 'object' && 'message' in current) {
      const message = (current as { message?: unknown }).message;
      if (typeof message === 'string') {
        parts.push(message);
      }
    }
    if (typeof current === 'object' && 'cause' in current) {
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return parts.join(' | ');
}
