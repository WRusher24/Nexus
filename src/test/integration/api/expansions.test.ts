import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { __resetRateLimits } from '../../../lib/http/rateLimit';
import { ensureUserQuota } from '../../../lib/queue/quota';
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
import { insertNode, uniqueQid } from '../../helpers/fixtures';
import {
  insertExpansionRequest,
  seedFocalScenario,
} from '../../helpers/workerHarness';

describe('/api/expansions', () => {
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
    __resetRateLimits();
  });

  it('queues a fresh expansion (202 QUEUED)', async () => {
    const userId = await insertTestUser(testDb.db);
    const scenario = await seedFocalScenario(testDb.db);
    const response = await callApi('/api/expansions', {
      method: 'POST',
      session: { userId },
      body: { nodeId: scenario.nodeId, direction: 'UPSTREAM' },
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { outcome: string; requestId: string };
    expect(body.outcome).toBe('QUEUED');
    expect(body.requestId).toBeTruthy();
  });

  it('returns a cache hit for an already-expanded node (200)', async () => {
    const userId = await insertTestUser(testDb.db);
    const scenario = await seedFocalScenario(testDb.db, {
      upstreamState: 'EXPANDED',
    });
    const response = await callApi('/api/expansions', {
      method: 'POST',
      session: { userId },
      body: { nodeId: scenario.nodeId, direction: 'UPSTREAM' },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { outcome: string };
    expect(body.outcome).toBe('CACHE_HIT');
  });

  it('joins an in-flight request (200 IN_PROGRESS)', async () => {
    const userId = await insertTestUser(testDb.db);
    const scenario = await seedFocalScenario(testDb.db, {
      upstreamState: 'QUEUED',
    });
    const existing = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      requestedBy: userId,
      status: 'PENDING',
    });
    const response = await callApi('/api/expansions', {
      method: 'POST',
      session: { userId },
      body: { nodeId: scenario.nodeId, direction: 'UPSTREAM' },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { outcome: string; requestId: string };
    expect(body.outcome).toBe('IN_PROGRESS');
    expect(body.requestId).toBe(existing);
  });

  it('rejects a node beyond the depth limit (403)', async () => {
    const userId = await insertTestUser(testDb.db);
    const orphan = await insertNode(testDb.db, {
      identityScheme: 'WIKIDATA',
      wikidataQid: uniqueQid(),
      isRoot: false,
      label: 'Orphan',
      nodeType: 'EVENT',
    });
    const response = await callApi('/api/expansions', {
      method: 'POST',
      session: { userId },
      body: { nodeId: orphan, direction: 'UPSTREAM' },
    });
    expect(response.status).toBe(403);
  });

  it('returns 429 with Retry-After when the quota is exhausted', async () => {
    const userId = await insertTestUser(testDb.db);
    await ensureUserQuota(testDb.db, userId, { dailyLimit: 0, monthlyLimit: 100 });
    const scenario = await seedFocalScenario(testDb.db);
    const response = await callApi('/api/expansions', {
      method: 'POST',
      session: { userId },
      body: { nodeId: scenario.nodeId, direction: 'UPSTREAM' },
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBeTruthy();
  });

  it('returns 404 for a nonexistent node', async () => {
    const userId = await insertTestUser(testDb.db);
    const response = await callApi('/api/expansions', {
      method: 'POST',
      session: { userId },
      body: { nodeId: randomUUID(), direction: 'UPSTREAM' },
    });
    expect(response.status).toBe(404);
  });

  it('returns 401 when unauthenticated', async () => {
    const response = await callApi('/api/expansions', {
      method: 'POST',
      session: null,
      body: { nodeId: randomUUID(), direction: 'UPSTREAM' },
    });
    expect(response.status).toBe(401);
  });

  it('returns the status of an expansion request (200)', async () => {
    const userId = await insertTestUser(testDb.db);
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      requestedBy: userId,
      status: 'LOCKED',
      attempt: 1,
    });
    const response = await callApi(`/api/expansions/${requestId}`, {
      method: 'GET',
      session: { userId },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; attempt: number };
    expect(body.status).toBe('LOCKED');
    expect(body.attempt).toBe(1);
  });

  it('returns 403 when the request belongs to another user', async () => {
    const userId = await insertTestUser(testDb.db);
    const other = await insertTestUser(testDb.db);
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      requestedBy: other,
    });
    const response = await callApi(`/api/expansions/${requestId}`, {
      method: 'GET',
      session: { userId },
    });
    expect(response.status).toBe(403);
  });

  it('returns 404 for a nonexistent expansion request', async () => {
    const userId = await insertTestUser(testDb.db);
    const response = await callApi(`/api/expansions/${randomUUID()}`, {
      method: 'GET',
      session: { userId },
    });
    expect(response.status).toBe(404);
  });
});
