import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { expansionRequests } from '../../../lib/db/schema';
import type { Database } from '../../../lib/graph/types';
import { startHeartbeat } from '../../../lib/queue/heartbeat';
import {
  closeTestDb,
  getTestDb,
  resetTestDb,
  type TestDb,
} from '../../helpers/db';
import { insertExpansionRequest, seedFocalScenario } from '../../helpers/workerHarness';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readLease(testDb: TestDb, id: string): Promise<Date | null> {
  const [row] = await testDb.db
    .select({ leaseExpiresAt: expansionRequests.leaseExpiresAt })
    .from(expansionRequests)
    .where(eq(expansionRequests.id, id));
  return row?.leaseExpiresAt ?? null;
}

describe('queue/heartbeat', () => {
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

  it('extends the lease on each tick', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'LOCKED',
      lockedBy: 'w1',
      leaseExpiresAt: new Date(Date.now() + 2_000),
    });

    const handle = await startHeartbeat(testDb.db, {
      requestId,
      workerId: 'w1',
      intervalSeconds: 0.05,
      leaseSeconds: 90,
    });
    await delay(200);
    await handle.stop();

    const lease = await readLease(testDb, requestId);
    expect(lease).not.toBeNull();
    expect((lease as Date).getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  it('stops updating the lease once stop() is called', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'LOCKED',
      lockedBy: 'w1',
      leaseExpiresAt: new Date(Date.now() + 5_000),
    });

    // A long interval guarantees no tick fires before stop().
    const handle = await startHeartbeat(testDb.db, {
      requestId,
      workerId: 'w1',
      intervalSeconds: 10,
      leaseSeconds: 90,
    });
    await handle.stop();
    const before = await readLease(testDb, requestId);
    await delay(150);
    const after = await readLease(testDb, requestId);
    expect(after?.getTime()).toBe(before?.getTime());
  });

  it('keeps ticking through a transient database error', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'LOCKED',
      lockedBy: 'w1',
      leaseExpiresAt: new Date(Date.now() + 2_000),
    });

    let calls = 0;
    const flaky = {
      execute: async (...args: unknown[]) => {
        calls += 1;
        if (calls === 1) throw new Error('transient connection reset');
        // Delegate the real execute on subsequent calls.
        return (testDb.db.execute as (...a: unknown[]) => unknown)(...args);
      },
    } as unknown as Database;

    const handle = await startHeartbeat(flaky, {
      requestId,
      workerId: 'w1',
      intervalSeconds: 0.05,
      leaseSeconds: 90,
    });
    await delay(220);
    await handle.stop();

    expect(handle.lastError).toBeTruthy();
    expect(handle.lostLease).toBe(false);
    // A later tick still extended the real lease.
    const lease = await readLease(testDb, requestId);
    expect((lease as Date).getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  it('stops when the request is no longer locked by this worker', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'LOCKED',
      lockedBy: 'someone-else',
      leaseExpiresAt: new Date(Date.now() + 5_000),
    });

    const handle = await startHeartbeat(testDb.db, {
      requestId,
      workerId: 'w1',
      intervalSeconds: 0.05,
      leaseSeconds: 90,
    });
    await delay(200);
    const lease = await readLease(testDb, requestId);
    expect(handle.lostLease).toBe(true);
    // The lease was never extended.
    expect((lease as Date).getTime()).toBeLessThan(Date.now() + 10_000);
    await handle.stop();
  });

  it('scopes ticks to the owning worker id', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'LOCKED',
      lockedBy: 'w1',
      leaseExpiresAt: new Date(Date.now() + 2_000),
    });

    const handle = await startHeartbeat(testDb.db, {
      requestId,
      workerId: 'w1',
      intervalSeconds: 0.05,
      leaseSeconds: 90,
    });
    await delay(150);
    expect(handle.lostLease).toBe(false);

    // Another worker takes over the lease.
    await testDb.db
      .update(expansionRequests)
      .set({ lockedBy: 'w2' })
      .where(eq(expansionRequests.id, requestId));

    await delay(150);
    expect(handle.lostLease).toBe(true);
    await handle.stop();
  });
});
