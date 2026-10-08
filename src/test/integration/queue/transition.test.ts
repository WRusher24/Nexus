import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { expansionRequests, nodes } from '../../../lib/db/schema';
import { transition, type NodeExpansionState } from '../../../lib/queue/transition';
import {
  closeTestDb,
  getTestDb,
  resetTestDb,
  type TestDb,
} from '../../helpers/db';
import { insertExpansionRequest, seedFocalScenario } from '../../helpers/workerHarness';

async function readRequest(db: TestDb, id: string) {
  const [row] = await db.db
    .select()
    .from(expansionRequests)
    .where(eq(expansionRequests.id, id));
  return row;
}

async function readNode(db: TestDb, id: string) {
  const [row] = await db.db.select().from(nodes).where(eq(nodes.id, id));
  return row;
}

describe('queue/transition', () => {
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

  it('PENDING -> LOCKED updates the request and sets the node to LOADING', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'PENDING',
    });

    const result = await transition(testDb.db, {
      requestId,
      fromStatus: 'PENDING',
      toStatus: 'LOCKED',
      patch: { lockedBy: 'worker-1', leaseExpiresAt: new Date(Date.now() + 90_000) },
    });

    expect(result).toEqual({
      outcome: 'TRANSITIONED',
      newStatus: 'LOCKED',
      newNodeState: 'LOADING',
    });
    expect((await readRequest(testDb, requestId))?.status).toBe('LOCKED');
    expect((await readNode(testDb, scenario.nodeId))?.upstreamState).toBe('LOADING');
  });

  it('LOCKED -> COMPLETED sets the node to EXPANDED by default', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'LOCKED',
      lockedBy: 'worker-1',
    });

    const result = await transition(testDb.db, {
      requestId,
      fromStatus: 'LOCKED',
      toStatus: 'COMPLETED',
    });

    expect(result.outcome).toBe('TRANSITIONED');
    expect((await readNode(testDb, scenario.nodeId))?.upstreamState).toBe('EXPANDED');
  });

  it('LOCKED -> COMPLETED with nodeStateOverride SPARSE sets the node to SPARSE', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'LOCKED',
    });

    await transition(testDb.db, {
      requestId,
      fromStatus: 'LOCKED',
      toStatus: 'COMPLETED',
      nodeStateOverride: 'SPARSE',
    });

    expect((await readNode(testDb, scenario.nodeId))?.upstreamState).toBe('SPARSE');
  });

  it('rejects the illegal transition PENDING -> COMPLETED without touching the DB', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'PENDING',
    });

    const result = await transition(testDb.db, {
      requestId,
      fromStatus: 'PENDING',
      toStatus: 'COMPLETED',
    });

    expect(result.outcome).toBe('ILLEGAL');
    expect((await readRequest(testDb, requestId))?.status).toBe('PENDING');
    expect((await readNode(testDb, scenario.nodeId))?.upstreamState).toBe('UNEXPANDED');
  });

  it('rejects the illegal transition COMPLETED -> PENDING (COMPLETED is terminal)', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'COMPLETED',
    });

    const result = await transition(testDb.db, {
      requestId,
      fromStatus: 'COMPLETED',
      toStatus: 'PENDING',
    });

    expect(result.outcome).toBe('ILLEGAL');
    expect((await readRequest(testDb, requestId))?.status).toBe('COMPLETED');
  });

  it('allows the manual-retry transition FAILED -> PENDING', async () => {
    const scenario = await seedFocalScenario(testDb.db, { upstreamState: 'FAILED' });
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'FAILED',
    });

    const result = await transition(testDb.db, {
      requestId,
      fromStatus: 'FAILED',
      toStatus: 'PENDING',
    });

    expect(result.outcome).toBe('TRANSITIONED');
    expect((await readNode(testDb, scenario.nodeId))?.upstreamState).toBe('QUEUED');
  });

  it('returns STALE/STATUS_CHANGED when the expected status no longer matches', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'LOCKED',
    });

    const result = await transition(testDb.db, {
      requestId,
      fromStatus: 'PENDING',
      toStatus: 'LOCKED',
    });

    expect(result).toEqual({ outcome: 'STALE', reason: 'STATUS_CHANGED' });
    expect((await readRequest(testDb, requestId))?.status).toBe('LOCKED');
  });

  it('returns STALE/REQUEST_NOT_FOUND for a missing request id', async () => {
    const result = await transition(testDb.db, {
      requestId: '00000000-0000-0000-0000-000000000000',
      fromStatus: 'PENDING',
      toStatus: 'LOCKED',
    });

    expect(result).toEqual({ outcome: 'STALE', reason: 'REQUEST_NOT_FOUND' });
  });

  it('rolls the whole transaction back if the node update fails', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'PENDING',
    });

    // An invalid enum value makes the node UPDATE fail after the request UPDATE
    // has already been applied, proving the two updates are atomic.
    await expect(
      transition(testDb.db, {
        requestId,
        fromStatus: 'PENDING',
        toStatus: 'LOCKED',
        nodeStateOverride: 'BOGUS' as unknown as NodeExpansionState,
      }),
    ).rejects.toBeTruthy();

    expect((await readRequest(testDb, requestId))?.status).toBe('PENDING');
    expect((await readNode(testDb, scenario.nodeId))?.upstreamState).toBe('UNEXPANDED');
  });

  it('updates downstreamState for a DOWNSTREAM request', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'DOWNSTREAM',
      status: 'PENDING',
    });

    await transition(testDb.db, {
      requestId,
      fromStatus: 'PENDING',
      toStatus: 'LOCKED',
    });

    const node = await readNode(testDb, scenario.nodeId);
    expect(node?.downstreamState).toBe('LOADING');
    expect(node?.upstreamState).toBe('UNEXPANDED');
  });

  it('lets only one of two concurrent transitions win', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'PENDING',
    });

    const results = await Promise.all([
      transition(testDb.db, { requestId, fromStatus: 'PENDING', toStatus: 'LOCKED' }),
      transition(testDb.db, { requestId, fromStatus: 'PENDING', toStatus: 'LOCKED' }),
    ]);

    const outcomes = results.map((r) => r.outcome).sort();
    expect(outcomes).toEqual(['STALE', 'TRANSITIONED']);
  });

  it('records the explicit attempt patch', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'PENDING',
    });

    await transition(testDb.db, {
      requestId,
      fromStatus: 'PENDING',
      toStatus: 'LOCKED',
      patch: { attempt: 7, lockedBy: 'worker-x' },
    });

    const request = await readRequest(testDb, requestId);
    expect(request?.attempt).toBe(7);
    expect(request?.lockedBy).toBe('worker-x');
  });
});
