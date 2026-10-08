import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureUserQuota, reserveUserQuota } from '../../../lib/queue/quota';
import {
  callApi,
  insertTestUser,
  setTestDb,
} from '../../helpers/apiClient';
import {
  closeTestDb,
  getTestDb,
  resetTestDb,
  type TestDb,
} from '../../helpers/db';

describe('GET /api/quota', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await getTestDb();
  }, 60000);

  afterAll(async () => {
    await closeTestDb(testDb);
  });

  beforeEach(async () => {
    await resetTestDb(testDb);
    setTestDb(testDb.db);
  });

  it('auto-creates a quota row with defaults for a new user', async () => {
    const userId = await insertTestUser(testDb.db);
    const response = await callApi('/api/quota', {
      method: 'GET',
      session: { userId },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      expansionsToday: number;
      expansionsThisMonth: number;
      dailyLimit: number;
      monthlyLimit: number;
      remainingToday: number;
      remainingThisMonth: number;
    };
    expect(body).toMatchObject({
      expansionsToday: 0,
      expansionsThisMonth: 0,
      dailyLimit: 20,
      monthlyLimit: 200,
      remainingToday: 20,
      remainingThisMonth: 200,
    });
  });

  it('reflects consumed expansions', async () => {
    const userId = await insertTestUser(testDb.db);
    await ensureUserQuota(testDb.db, userId);
    expect(await reserveUserQuota(testDb.db, userId)).not.toBeNull();
    expect(await reserveUserQuota(testDb.db, userId)).not.toBeNull();

    const response = await callApi('/api/quota', {
      method: 'GET',
      session: { userId },
    });
    const body = (await response.json()) as {
      expansionsToday: number;
      expansionsThisMonth: number;
      remainingToday: number;
    };
    expect(body.expansionsToday).toBe(2);
    expect(body.expansionsThisMonth).toBe(2);
    expect(body.remainingToday).toBe(18);
  });

  it('returns 401 when unauthenticated', async () => {
    const response = await callApi('/api/quota', {
      method: 'GET',
      session: null,
    });
    expect(response.status).toBe(401);
  });

  it('computes remaining counts from custom limits', async () => {
    const userId = await insertTestUser(testDb.db);
    await ensureUserQuota(testDb.db, userId, { dailyLimit: 5, monthlyLimit: 100 });
    expect(await reserveUserQuota(testDb.db, userId)).not.toBeNull();
    expect(await reserveUserQuota(testDb.db, userId)).not.toBeNull();

    const response = await callApi('/api/quota', {
      method: 'GET',
      session: { userId },
    });
    const body = (await response.json()) as {
      remainingToday: number;
      remainingThisMonth: number;
    };
    expect(body.remainingToday).toBe(3);
    expect(body.remainingThisMonth).toBe(98);
  });
});
