import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reconcileBudget, reserveBudget } from '../../../lib/extraction/budget';
import { globalBudget } from '../../../lib/db/schema';
import {
  closeTestDb,
  getTestDb,
  resetTestDb,
  type TestDb,
} from '../../helpers/db';

async function readBudget(testDb: TestDb) {
  const [row] = await testDb.db
    .select()
    .from(globalBudget)
    .where(eq(globalBudget.id, 'singleton'));
  if (!row) throw new Error('globalBudget singleton missing');
  return row;
}

describe('budget reservation', () => {
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

  it('reserves against a fresh budget', async () => {
    const reservation = await reserveBudget(testDb.db, 0.5);
    expect(reservation).not.toBeNull();
    expect(reservation?.reservedAmountUsd).toBe(0.5);

    const budget = await readBudget(testDb);
    expect(budget.spentTodayUsd).toBeCloseTo(0.5, 10);
    expect(budget.spentThisMonthUsd).toBeCloseTo(0.5, 10);
  });

  it('returns null when the daily budget would be exceeded, leaving the DB unchanged', async () => {
    await testDb.db
      .update(globalBudget)
      .set({ dailyBudgetUsd: 1, spentTodayUsd: 0.9 })
      .where(eq(globalBudget.id, 'singleton'));

    const reservation = await reserveBudget(testDb.db, 0.5);
    expect(reservation).toBeNull();

    const budget = await readBudget(testDb);
    expect(budget.spentTodayUsd).toBeCloseTo(0.9, 10);
  });

  it('returns null when the monthly budget would be exceeded', async () => {
    await testDb.db
      .update(globalBudget)
      .set({ monthlyBudgetUsd: 1, spentThisMonthUsd: 0.9, dailyBudgetUsd: 100 })
      .where(eq(globalBudget.id, 'singleton'));

    const reservation = await reserveBudget(testDb.db, 0.5);
    expect(reservation).toBeNull();

    const budget = await readBudget(testDb);
    expect(budget.spentThisMonthUsd).toBeCloseTo(0.9, 10);
  });

  it('fails when the system is paused', async () => {
    await testDb.db
      .update(globalBudget)
      .set({ isPaused: true })
      .where(eq(globalBudget.id, 'singleton'));

    const reservation = await reserveBudget(testDb.db, 0.5);
    expect(reservation).toBeNull();
  });

  it('rolls the day over before reserving', async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayDate = yesterday.toISOString().slice(0, 10);

    await testDb.db
      .update(globalBudget)
      .set({ currentDay: yesterdayDate, spentTodayUsd: 10 })
      .where(eq(globalBudget.id, 'singleton'));

    const reservation = await reserveBudget(testDb.db, 0.5);
    expect(reservation).not.toBeNull();

    const budget = await readBudget(testDb);
    expect(budget.spentTodayUsd).toBeCloseTo(0.5, 10);
    expect(budget.currentDay).not.toBe(yesterdayDate);
  });

  it('reconciles downwards when actual cost is less than estimated', async () => {
    const reservation = await reserveBudget(testDb.db, 0.5);
    expect(reservation).not.toBeNull();

    await reconcileBudget(testDb.db, reservation!, 0.3);

    const budget = await readBudget(testDb);
    expect(budget.spentTodayUsd).toBeCloseTo(0.3, 10);
    expect(budget.spentThisMonthUsd).toBeCloseTo(0.3, 10);
  });

  it('refunds the full reservation when the extraction failed', async () => {
    const before = await readBudget(testDb);
    const reservation = await reserveBudget(testDb.db, 0.5);
    expect(reservation).not.toBeNull();

    await reconcileBudget(testDb.db, reservation!, 0);

    const budget = await readBudget(testDb);
    expect(budget.spentTodayUsd).toBeCloseTo(before.spentTodayUsd, 10);
  });

  it('allows at most one of two concurrent reservations that would exceed the cap', async () => {
    await testDb.db
      .update(globalBudget)
      .set({ dailyBudgetUsd: 50, monthlyBudgetUsd: 500, spentTodayUsd: 0, spentThisMonthUsd: 0 })
      .where(eq(globalBudget.id, 'singleton'));

    const [a, b] = await Promise.all([
      reserveBudget(testDb.db, 40),
      reserveBudget(testDb.db, 40),
    ]);

    const successes = [a, b].filter((r) => r !== null);
    expect(successes).toHaveLength(1);

    const budget = await readBudget(testDb);
    expect(budget.spentTodayUsd).toBeCloseTo(40, 10);
  });
});
