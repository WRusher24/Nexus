import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  edges,
  expansionRequests,
  nodes,
} from '../../../lib/db/schema';
import { claimNextRequest } from '../../../lib/queue/claim';
import { processExpansion } from '../../../lib/queue/processExpansion';
import { ensureUserQuota } from '../../../lib/queue/quota';
import { runReaper } from '../../../lib/queue/reaper';
import { requestExpansion } from '../../../lib/queue/requestExpansion';
import { runWorkerLoop } from '../../../worker/runLoop';
import {
  closeTestDb,
  getTestDb,
  resetTestDb,
  type TestDb,
} from '../../helpers/db';
import {
  buildFixtureConfig,
  drainOne,
  richOutput,
  seedFocalScenario,
  waitFor,
} from '../../helpers/workerHarness';

async function readRequest(testDb: TestDb, id: string) {
  const [row] = await testDb.db
    .select()
    .from(expansionRequests)
    .where(eq(expansionRequests.id, id));
  return row;
}

async function readUpstreamState(testDb: TestDb, nodeId: string) {
  const [row] = await testDb.db
    .select({ upstreamState: nodes.upstreamState })
    .from(nodes)
    .where(eq(nodes.id, nodeId));
  return row?.upstreamState;
}

describe('worker/endToEnd', () => {
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

  it('happy path: request -> worker -> edges -> cache hit', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const queued = await requestExpansion(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      userId: 'user-1',
    });
    expect(queued.outcome).toBe('QUEUED');
    if (queued.outcome !== 'QUEUED') return;

    const controller = new AbortController();
    const loop = runWorkerLoop(testDb.db, {
      workerId: 'worker-happy',
      config: buildFixtureConfig(scenario, richOutput()),
      pollIntervalSeconds: 0.05,
      reaperIntervalSeconds: 10,
      signal: controller.signal,
    });

    await waitFor(async () => (await readUpstreamState(testDb, scenario.nodeId)) === 'EXPANDED', {
      timeoutMs: 8000,
    });
    controller.abort();
    await loop;

    const request = await readRequest(testDb, queued.requestId);
    expect(request?.status).toBe('COMPLETED');
    expect(request?.extractionRunId).not.toBeNull();

    const persistedEdges = await testDb.db
      .select()
      .from(edges)
      .where(eq(edges.firstExtractionRunId, request?.extractionRunId as string));
    expect(persistedEdges).toHaveLength(3);

    // A second click is a cache hit and costs nothing further.
    const again = await requestExpansion(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      userId: 'user-1',
    });
    expect(again.outcome).toBe('CACHE_HIT');
    if (again.outcome === 'CACHE_HIT') {
      expect(again.extractionRunId).toBe(request?.extractionRunId);
    }
  });

  it('crash recovery: worker A dies, reaper reclaims, worker B completes', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const queued = await requestExpansion(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      userId: 'user-1',
    });
    if (queued.outcome !== 'QUEUED') throw new Error('expected queued');

    // Worker A claims the request but then "crashes" mid-processing.
    const claimedByA = await claimNextRequest(testDb.db, { workerId: 'worker-A' });
    expect(claimedByA).not.toBeNull();
    expect(claimedByA?.attempt).toBe(1);
    await testDb.db
      .update(expansionRequests)
      .set({ leaseExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(expansionRequests.id, queued.requestId));

    // The reaper releases the orphaned lease, preserving the attempt count.
    const reaped = await runReaper(testDb.db);
    expect(reaped.reclaimedToPending).toBe(1);

    const afterReap = await readRequest(testDb, queued.requestId);
    expect(afterReap?.status).toBe('PENDING');
    expect(afterReap?.attempt).toBe(1);

    // Clear the backoff so worker B can pick it up immediately.
    await testDb.db
      .update(expansionRequests)
      .set({ retryAfter: new Date(Date.now() - 1000) })
      .where(eq(expansionRequests.id, queued.requestId));

    const claimedByB = await claimNextRequest(testDb.db, { workerId: 'worker-B' });
    expect(claimedByB?.id).toBe(queued.requestId);
    expect(claimedByB?.attempt).toBe(2);
    if (!claimedByB) throw new Error('worker B failed to claim');

    const result = await processExpansion(testDb.db, {
      claimed: claimedByB,
      config: buildFixtureConfig(scenario, richOutput()),
    });
    expect(result.outcome).toBe('COMPLETED');

    expect(await readUpstreamState(testDb, scenario.nodeId)).toBe('EXPANDED');
    const request = await readRequest(testDb, queued.requestId);
    expect(request?.status).toBe('COMPLETED');
    expect(request?.lockedBy).toBeNull();
  });

  it('quota exhaustion: a user limit of 2 blocks the third expansion', async () => {
    await ensureUserQuota(testDb.db, 'user-limited', {
      dailyLimit: 2,
      monthlyLimit: 100,
    });

    const scenarios = [];
    for (let i = 0; i < 3; i += 1) {
      scenarios.push(await seedFocalScenario(testDb.db, { label: `Focal ${i}` }));
    }

    const first = await requestExpansion(testDb.db, {
      nodeId: scenarios[0]!.nodeId,
      direction: 'UPSTREAM',
      userId: 'user-limited',
    });
    const second = await requestExpansion(testDb.db, {
      nodeId: scenarios[1]!.nodeId,
      direction: 'UPSTREAM',
      userId: 'user-limited',
    });
    const third = await requestExpansion(testDb.db, {
      nodeId: scenarios[2]!.nodeId,
      direction: 'UPSTREAM',
      userId: 'user-limited',
    });

    expect(first.outcome).toBe('QUEUED');
    expect(second.outcome).toBe('QUEUED');
    expect(third).toMatchObject({ outcome: 'REJECTED', reason: 'QUOTA_EXCEEDED' });

    const config = buildFixtureConfig(scenarios[0]!, richOutput());
    const r1 = await drainOne(testDb.db, 'w1', config);
    const r2 = await drainOne(testDb.db, 'w1', config);
    expect(r1?.result.outcome).toBe('COMPLETED');
    expect(r2?.result.outcome).toBe('COMPLETED');

    expect(await readUpstreamState(testDb, scenarios[0]!.nodeId)).toBe('EXPANDED');
    expect(await readUpstreamState(testDb, scenarios[1]!.nodeId)).toBe('EXPANDED');
    expect(await readUpstreamState(testDb, scenarios[2]!.nodeId)).toBe('UNEXPANDED');
  });
});
