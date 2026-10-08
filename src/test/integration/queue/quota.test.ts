import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { userQuotas } from '../../../lib/db/schema';
import {
  ensureUserQuota,
  getUserQuota,
  refundUserQuota,
  reserveUserQuota,
} from '../../../lib/queue/quota';
import {
  closeTestDb,
  getTestDb,
  resetTestDb,
  type TestDb,
} from '../../helpers/db';

describe('queue/quota', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await getTestDb();
  }, 60000);

  afterAll(async () => {
    await resetTestDb(testDb);
    await closeTestDb(testDb);
  });

  beforeEach(async () => {
    await resetTestDb(testDb);
  });

  it('ensureUserQuota creates a row with the default limits', async () => {
    await ensureUserQuota(testDb.db, 'user-new');
    const quota = await getUserQuota(testDb.db, 'user-new');
    expect(quota?.dailyLimit).toBe(20);
    expect(quota?.monthlyLimit).toBe(200);
    expect(quota?.expansionsToday).toBe(0);
    expect(quota?.expansionsThisMonth).toBe(0);
  });

  it('ensureUserQuota is idempotent', async () => {
    await ensureUserQuota(testDb.db, 'user-x', { dailyLimit: 5 });
    await ensureUserQuota(testDb.db, 'user-x', { dailyLimit: 99 });
    const rows = await testDb.db
      .select()
      .from(userQuotas)
      .where(eq(userQuotas.userId, 'user-x'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dailyLimit).toBe(5);
  });

  it('reserves under the limit and increments both counters', async () => {
    await ensureUserQuota(testDb.db, 'user-a');
    const reservation = await reserveUserQuota(testDb.db, 'user-a');
    expect(reservation).not.toBeNull();
    expect(reservation?.userId).toBe('user-a');

    const quota = await getUserQuota(testDb.db, 'user-a');
    expect(quota?.expansionsToday).toBe(1);
    expect(quota?.expansionsThisMonth).toBe(1);
  });

  it('returns null at the daily limit', async () => {
    await ensureUserQuota(testDb.db, 'user-b', { dailyLimit: 1, monthlyLimit: 100 });
    expect(await reserveUserQuota(testDb.db, 'user-b')).not.toBeNull();
    expect(await reserveUserQuota(testDb.db, 'user-b')).toBeNull();
    const quota = await getUserQuota(testDb.db, 'user-b');
    expect(quota?.expansionsToday).toBe(1);
  });

  it('returns null at the monthly limit', async () => {
    await ensureUserQuota(testDb.db, 'user-c', { dailyLimit: 100, monthlyLimit: 1 });
    expect(await reserveUserQuota(testDb.db, 'user-c')).not.toBeNull();
    expect(await reserveUserQuota(testDb.db, 'user-c')).toBeNull();
  });

  it('rolls the daily counter over when the day changes', async () => {
    await ensureUserQuota(testDb.db, 'user-d', { dailyLimit: 1 });
    await testDb.db.execute(sql`
      UPDATE "userQuotas"
      SET "expansionsToday" = 1, "currentDay" = CURRENT_DATE - 1
      WHERE "userId" = 'user-d'
    `);

    const reservation = await reserveUserQuota(testDb.db, 'user-d');
    expect(reservation).not.toBeNull();
    const quota = await getUserQuota(testDb.db, 'user-d');
    expect(quota?.expansionsToday).toBe(1);
  });

  it('rolls the monthly counter over when the month changes', async () => {
    await ensureUserQuota(testDb.db, 'user-e', { dailyLimit: 100, monthlyLimit: 1 });
    await testDb.db.execute(sql`
      UPDATE "userQuotas"
      SET "expansionsThisMonth" = 1,
          "currentMonth" = date_trunc('month', CURRENT_DATE) - interval '1 month'
      WHERE "userId" = 'user-e'
    `);

    const reservation = await reserveUserQuota(testDb.db, 'user-e');
    expect(reservation).not.toBeNull();
    const quota = await getUserQuota(testDb.db, 'user-e');
    expect(quota?.expansionsThisMonth).toBe(1);
  });

  it('refunds a reservation without going below zero', async () => {
    await ensureUserQuota(testDb.db, 'user-f');
    const reservation = await reserveUserQuota(testDb.db, 'user-f');
    expect(reservation).not.toBeNull();
    if (!reservation) return;

    await refundUserQuota(testDb.db, reservation);
    let quota = await getUserQuota(testDb.db, 'user-f');
    expect(quota?.expansionsToday).toBe(0);
    expect(quota?.expansionsThisMonth).toBe(0);

    // A second refund must not underflow.
    await refundUserQuota(testDb.db, reservation);
    quota = await getUserQuota(testDb.db, 'user-f');
    expect(quota?.expansionsToday).toBe(0);
  });

  it('lets exactly one of two concurrent reservations through a limit of 1', async () => {
    await ensureUserQuota(testDb.db, 'user-g', { dailyLimit: 1, monthlyLimit: 1 });

    const results = await Promise.all([
      reserveUserQuota(testDb.db, 'user-g'),
      reserveUserQuota(testDb.db, 'user-g'),
    ]);

    const successes = results.filter((r) => r !== null);
    expect(successes).toHaveLength(1);
    const quota = await getUserQuota(testDb.db, 'user-g');
    expect(quota?.expansionsToday).toBe(1);
  });
});
