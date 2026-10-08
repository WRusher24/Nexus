import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { expansionRequests, nodes } from '../../../lib/db/schema';
import { claimNextRequest } from '../../../lib/queue/claim';
import {
  closeTestDb,
  getTestDb,
  resetTestDb,
  type TestDb,
} from '../../helpers/db';
import { insertExpansionRequest, seedFocalScenario } from '../../helpers/workerHarness';

async function readRequest(testDb: TestDb, id: string) {
  const [row] = await testDb.db
    .select()
    .from(expansionRequests)
    .where(eq(expansionRequests.id, id));
  return row;
}

describe('queue/claim', () => {
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

  it('returns null when there is nothing to claim', async () => {
    const claimed = await claimNextRequest(testDb.db, { workerId: 'w1' });
    expect(claimed).toBeNull();
  });

  it('claims one pending request and moves the node to LOADING', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
    });

    const claimed = await claimNextRequest(testDb.db, { workerId: 'w1' });
    expect(claimed).not.toBeNull();
    expect(claimed?.id).toBe(requestId);
    expect(claimed?.attempt).toBe(1);
    expect(claimed?.lockedBy).toBe('w1');

    const request = await readRequest(testDb, requestId);
    expect(request?.status).toBe('LOCKED');

    const [node] = await testDb.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, scenario.nodeId));
    expect(node?.upstreamState).toBe('LOADING');
  });

  it('gives two concurrent workers different requests (SKIP LOCKED)', async () => {
    const s1 = await seedFocalScenario(testDb.db);
    const s2 = await seedFocalScenario(testDb.db);
    const r1 = await insertExpansionRequest(testDb.db, {
      nodeId: s1.nodeId,
      direction: 'UPSTREAM',
    });
    const r2 = await insertExpansionRequest(testDb.db, {
      nodeId: s2.nodeId,
      direction: 'UPSTREAM',
    });

    const [a, b] = await Promise.all([
      claimNextRequest(testDb.db, { workerId: 'w1' }),
      claimNextRequest(testDb.db, { workerId: 'w2' }),
    ]);

    const ids = [a?.id, b?.id].filter((id): id is string => Boolean(id)).sort();
    expect(ids).toEqual([r1, r2].sort());
  });

  it('skips a request whose retryAfter is in the future', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      retryAfter: new Date(Date.now() + 60_000),
    });

    const claimed = await claimNextRequest(testDb.db, { workerId: 'w1' });
    expect(claimed).toBeNull();
  });

  it('claims a request whose retryAfter is in the past', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      retryAfter: new Date(Date.now() - 1000),
    });

    const claimed = await claimNextRequest(testDb.db, { workerId: 'w1' });
    expect(claimed?.id).toBe(requestId);
  });

  it('claims requests in FIFO order by createdAt', async () => {
    const s1 = await seedFocalScenario(testDb.db);
    const s2 = await seedFocalScenario(testDb.db);
    const older = await insertExpansionRequest(testDb.db, {
      nodeId: s1.nodeId,
      direction: 'UPSTREAM',
    });
    const newer = await insertExpansionRequest(testDb.db, {
      nodeId: s2.nodeId,
      direction: 'UPSTREAM',
    });
    await testDb.db
      .update(expansionRequests)
      .set({ createdAt: new Date(Date.now() - 10_000) })
      .where(eq(expansionRequests.id, older));

    const first = await claimNextRequest(testDb.db, { workerId: 'w1' });
    const second = await claimNextRequest(testDb.db, { workerId: 'w1' });
    expect(first?.id).toBe(older);
    expect(second?.id).toBe(newer);
  });

  it('sets the lease roughly 90 seconds into the future', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
    });

    const before = Date.now();
    const claimed = await claimNextRequest(testDb.db, { workerId: 'w1' });
    const after = Date.now();
    expect(claimed).not.toBeNull();
    if (!claimed) return;

    const leaseMs = claimed.leaseExpiresAt.getTime();
    expect(leaseMs).toBeGreaterThanOrEqual(before + 89_000);
    expect(leaseMs).toBeLessThanOrEqual(after + 91_000);
  });

  it('increments attempt atomically on every claim', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'PENDING',
    });

    const first = await claimNextRequest(testDb.db, { workerId: 'w1' });
    expect(first?.attempt).toBe(1);

    // Simulate the reaper releasing the lease (without touching attempt), then
    // claim again: the counter must advance to 2.
    await testDb.db
      .update(expansionRequests)
      .set({ status: 'PENDING', lockedBy: null, leaseExpiresAt: null })
      .where(eq(expansionRequests.id, requestId));

    const second = await claimNextRequest(testDb.db, { workerId: 'w1' });
    expect(second?.attempt).toBe(2);
  });
});
