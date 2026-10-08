import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../../lib/db/schema';
import {
  isSerializationFailure,
  withSerializableRetry,
} from '../../../lib/graph/insertVerifiedEdge';
import type { Database, Transaction } from '../../../lib/graph/types';
import {
  closeTestDb,
  getTestDatabaseUrl,
  getTestDb,
  resetTestDb,
  type TestDb,
} from '../../helpers/db';

/**
 * Coverage for the SERIALIZABLE retry wrapper.
 *
 * The pure cases pin down classification and loop behaviour with a fake
 * runner. The DB-backed case provokes a genuine PostgreSQL serialization
 * failure (40001) with two overlapping SERIALIZABLE transactions and proves
 * the wrapper recovers.
 */

function pgError(code: string, nested = false): Error {
  const root = Object.assign(new Error('driver error'), { code });
  if (!nested) return root;
  return Object.assign(new Error('drizzle wrapper'), { cause: root });
}

/** Resolve once `parties` callers have arrived. */
function makeBarrier(parties: number): () => Promise<void> {
  let count = 0;
  let release: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    count += 1;
    if (count >= parties) release();
    await reached;
  };
}

describe('withSerializableRetry (pure)', () => {
  it('classifies direct and nested serialization failures', () => {
    expect(isSerializationFailure(pgError('40001'))).toBe(true);
    expect(isSerializationFailure(pgError('40001', true))).toBe(true);
    expect(isSerializationFailure(pgError('40P01'))).toBe(true);
    expect(isSerializationFailure(pgError('23505'))).toBe(false);
    expect(isSerializationFailure(new Error('no code'))).toBe(false);
  });

  it('retries a serialization failure and eventually succeeds', async () => {
    let attempts = 0;
    const fakeTx = {} as Transaction;
    const fakeDb = {
      transaction: async (fn: (tx: Transaction) => Promise<string>) => {
        attempts += 1;
        if (attempts < 3) {
          throw pgError('40001', true);
        }
        return fn(fakeTx);
      },
    } as unknown as Database;

    const result = await withSerializableRetry(fakeDb, async () => 'ok');
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('does not retry non-serialization errors', async () => {
    let attempts = 0;
    const fakeDb = {
      transaction: async () => {
        attempts += 1;
        throw pgError('23505');
      },
    } as unknown as Database;

    await expect(
      withSerializableRetry(fakeDb, async () => 'never'),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it('gives up after max retries and rethrows', async () => {
    let attempts = 0;
    const fakeDb = {
      transaction: async () => {
        attempts += 1;
        throw pgError('40001');
      },
    } as unknown as Database;

    await expect(
      withSerializableRetry(fakeDb, async () => 'never', 3),
    ).rejects.toMatchObject({ code: '40001' });
    expect(attempts).toBe(3);
  });
});

describe('withSerializableRetry (real PostgreSQL 40001)', () => {
  let testDb: TestDb;
  let pool2: Pool;
  let db2: Database;

  beforeAll(async () => {
    testDb = await getTestDb();
    pool2 = new Pool({ connectionString: getTestDatabaseUrl(), max: 5 });
    db2 = drizzle(pool2, { schema });
  }, 60000);

  afterAll(async () => {
    await pool2.end();
    await resetTestDb(testDb);
    await closeTestDb(testDb);
  });

  beforeEach(async () => {
    await resetTestDb(testDb);
  });

  it('retries a genuine serialization failure (write skew on globalBudget)', async () => {
    const barrier = makeBarrier(2);
    let invocations = 0;

    const fn = async (tx: Transaction): Promise<string> => {
      invocations += 1;
      // Read a common row, hold until both transactions have read, then both
      // write the same row. Under SERIALIZABLE one of them must fail with
      // 40001; the wrapper retries it and it then succeeds.
      await tx.execute(
        sql`SELECT "spentTodayUsd" FROM "globalBudget" WHERE "id" = 'singleton'`,
      );
      await barrier();
      await tx.execute(
        sql`UPDATE "globalBudget" SET "spentTodayUsd" = "spentTodayUsd" + 1 WHERE "id" = 'singleton'`,
      );
      return 'ok';
    };

    const results = await Promise.all([
      withSerializableRetry(testDb.db, fn),
      withSerializableRetry(db2, fn),
    ]);

    expect(results).toEqual(['ok', 'ok']);
    // 2 first attempts + at least one retry means a real 40001 was handled.
    expect(invocations).toBeGreaterThanOrEqual(3);

    const [budget] = await testDb.db.execute<{ spentTodayUsd: number }>(
      sql`SELECT "spentTodayUsd" FROM "globalBudget" WHERE "id" = 'singleton'`,
    ).then((r) => r.rows);
    expect(budget?.spentTodayUsd).toBe(2);
  });
});
