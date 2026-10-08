import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { expansionRequests, nodes } from '../../../lib/db/schema';
import { runReaper } from '../../../lib/queue/reaper';
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

async function readNodeState(testDb: TestDb, id: string) {
  const [row] = await testDb.db
    .select({ upstreamState: nodes.upstreamState })
    .from(nodes)
    .where(eq(nodes.id, id));
  return row?.upstreamState;
}

const PAST = () => new Date(Date.now() - 60_000);

describe('queue/reaper', () => {
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

  it('returns an expired lease to PENDING and the node to QUEUED', async () => {
    const scenario = await seedFocalScenario(testDb.db, { upstreamState: 'LOADING' });
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'EXTRACTING',
      attempt: 1,
      lockedBy: 'w1',
      leaseExpiresAt: PAST(),
    });

    const result = await runReaper(testDb.db);
    expect(result.reclaimedToPending).toBe(1);
    expect(result.movedToFailed).toBe(0);

    const request = await readRequest(testDb, requestId);
    expect(request?.status).toBe('PENDING');
    expect(request?.lockedBy).toBeNull();
    expect(request?.leaseExpiresAt).toBeNull();
    expect(request?.retryAfter).not.toBeNull();
    expect(await readNodeState(testDb, scenario.nodeId)).toBe('QUEUED');
  });

  it('fails a request whose expired lease has exhausted its attempts', async () => {
    const scenario = await seedFocalScenario(testDb.db, { upstreamState: 'LOADING' });
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'LOCKED',
      attempt: 3,
      lockedBy: 'w1',
      leaseExpiresAt: PAST(),
    });

    const result = await runReaper(testDb.db);
    expect(result).toEqual({ reclaimedToPending: 0, movedToFailed: 1 });

    const request = await readRequest(testDb, requestId);
    expect(request?.status).toBe('FAILED');
    expect(request?.leaseExpiresAt).toBeNull();
    expect(await readNodeState(testDb, scenario.nodeId)).toBe('FAILED');
  });

  it('leaves a still-valid lease untouched', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'LOCKED',
      attempt: 1,
      lockedBy: 'w1',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });

    const result = await runReaper(testDb.db);
    expect(result).toEqual({ reclaimedToPending: 0, movedToFailed: 0 });
    expect((await readRequest(testDb, requestId))?.status).toBe('LOCKED');
  });

  it('leaves a COMPLETED request untouched even with a stale lease field', async () => {
    const scenario = await seedFocalScenario(testDb.db, { upstreamState: 'EXPANDED' });
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'COMPLETED',
      attempt: 1,
      lockedBy: 'w1',
      leaseExpiresAt: PAST(),
    });

    const result = await runReaper(testDb.db);
    expect(result).toEqual({ reclaimedToPending: 0, movedToFailed: 0 });
    expect((await readRequest(testDb, requestId))?.status).toBe('COMPLETED');
  });

  it('does NOT increment the attempt counter', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'LOCKED',
      attempt: 2,
      lockedBy: 'w1',
      leaseExpiresAt: PAST(),
    });

    await runReaper(testDb.db);
    expect((await readRequest(testDb, requestId))?.attempt).toBe(2);
  });

  it('applies the 30s / 120s backoff schedule', async () => {
    const s1 = await seedFocalScenario(testDb.db);
    const s2 = await seedFocalScenario(testDb.db);
    const r1 = await insertExpansionRequest(testDb.db, {
      nodeId: s1.nodeId,
      direction: 'UPSTREAM',
      status: 'LOCKED',
      attempt: 1,
      lockedBy: 'w1',
      leaseExpiresAt: PAST(),
    });
    const r2 = await insertExpansionRequest(testDb.db, {
      nodeId: s2.nodeId,
      direction: 'UPSTREAM',
      status: 'LOCKED',
      attempt: 2,
      lockedBy: 'w1',
      leaseExpiresAt: PAST(),
    });

    const before = Date.now();
    await runReaper(testDb.db);
    const after = Date.now();

    const first = await readRequest(testDb, r1);
    const second = await readRequest(testDb, r2);
    const delta1 = (first?.retryAfter?.getTime() ?? 0) - before;
    const delta2 = (second?.retryAfter?.getTime() ?? 0) - after;

    expect(delta1).toBeGreaterThan(28_000);
    expect(delta1).toBeLessThan(32_000);
    expect(delta2).toBeGreaterThan(118_000);
    expect(delta2).toBeLessThan(122_000);
  });

  it('reclaims multiple stale requests in one run', async () => {
    const s1 = await seedFocalScenario(testDb.db);
    const s2 = await seedFocalScenario(testDb.db);
    await insertExpansionRequest(testDb.db, {
      nodeId: s1.nodeId,
      direction: 'UPSTREAM',
      status: 'LOCKED',
      attempt: 1,
      lockedBy: 'w1',
      leaseExpiresAt: PAST(),
    });
    await insertExpansionRequest(testDb.db, {
      nodeId: s2.nodeId,
      direction: 'UPSTREAM',
      status: 'FETCHING',
      attempt: 1,
      lockedBy: 'w2',
      leaseExpiresAt: PAST(),
    });

    const result = await runReaper(testDb.db);
    expect(result).toEqual({ reclaimedToPending: 2, movedToFailed: 0 });
  });

  it('is idempotent: a second run has no additional effect', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'LOCKED',
      attempt: 1,
      lockedBy: 'w1',
      leaseExpiresAt: PAST(),
    });

    const first = await runReaper(testDb.db);
    const second = await runReaper(testDb.db);
    expect(first).toEqual({ reclaimedToPending: 1, movedToFailed: 0 });
    expect(second).toEqual({ reclaimedToPending: 0, movedToFailed: 0 });
  });
});
