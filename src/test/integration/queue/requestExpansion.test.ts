import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { expansionRequests, nodes } from '../../../lib/db/schema';
import { getUserQuota, ensureUserQuota } from '../../../lib/queue/quota';
import { requestExpansion } from '../../../lib/queue/requestExpansion';
import type { EdgeInsertInput } from '../../../lib/graph/types';
import {
  closeTestDb,
  getTestDb,
  resetTestDb,
  type TestDb,
} from '../../helpers/db';
import {
  insertVerifiedEdgeThroughApp,
  makeEvidence,
} from '../../helpers/edgeHelper';
import {
  insertExtractionRun,
  insertNode,
  uniqueQid,
} from '../../helpers/fixtures';
import {
  insertExpansionRequest,
  seedFocalScenario,
} from '../../helpers/workerHarness';

async function readNodeState(
  testDb: TestDb,
  nodeId: string,
): Promise<{ upstreamState: string; downstreamState: string } | null> {
  const [row] = await testDb.db
    .select({
      upstreamState: nodes.upstreamState,
      downstreamState: nodes.downstreamState,
    })
    .from(nodes)
    .where(eq(nodes.id, nodeId));
  return row ?? null;
}

describe('queue/requestExpansion', () => {
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

  async function buildChain(
    rootNodeId: string,
    sourceDocumentId: string,
    depth: number,
  ): Promise<string> {
    const runId = await insertExtractionRun(testDb.db, {
      focalNodeId: rootNodeId,
      sourceDocumentId,
    });
    let current = rootNodeId;
    let year = 1900;
    for (let i = 0; i < depth; i += 1) {
      year += 1;
      const next = await insertNode(testDb.db, {
        identityScheme: 'WIKIDATA',
        wikidataQid: uniqueQid(),
        label: `Deep ${i}`,
        nodeType: 'EVENT',
        dateStartYear: year,
        dateStartPrecision: 'YEAR',
      });
      const input: EdgeInsertInput = {
        causeNodeId: current,
        effectNodeId: next,
        relationType: 'CAUSED',
        importanceRank: 5,
        contested: false,
        extractionRunId: runId,
        evidence: [makeEvidence({ sourceDocumentId, extractionRunId: runId })],
      };
      const result = await insertVerifiedEdgeThroughApp(testDb.db, input);
      if (result.outcome === 'REJECTED') {
        throw new Error(`chain edge rejected: ${result.reason}`);
      }
      current = next;
    }
    return current;
  }

  it('returns CACHE_HIT for an EXPANDED node without consuming quota', async () => {
    const scenario = await seedFocalScenario(testDb.db, { upstreamState: 'EXPANDED' });
    const result = await requestExpansion(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      userId: 'user-cache',
    });
    expect(result.outcome).toBe('CACHE_HIT');
    if (result.outcome === 'CACHE_HIT') expect(result.state).toBe('EXPANDED');
    expect(await getUserQuota(testDb.db, 'user-cache')).toBeNull();
  });

  it('returns CACHE_HIT with state SPARSE for a sparse node', async () => {
    const scenario = await seedFocalScenario(testDb.db, { upstreamState: 'SPARSE' });
    const result = await requestExpansion(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      userId: 'user-cache',
    });
    expect(result).toMatchObject({ outcome: 'CACHE_HIT', state: 'SPARSE' });
    expect(await getUserQuota(testDb.db, 'user-cache')).toBeNull();
  });

  it('returns IN_PROGRESS for a QUEUED node with an in-flight request', async () => {
    const scenario = await seedFocalScenario(testDb.db, { upstreamState: 'QUEUED' });
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'PENDING',
    });

    const result = await requestExpansion(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      userId: 'user-1',
    });
    expect(result).toEqual({ outcome: 'IN_PROGRESS', requestId });
    expect(await getUserQuota(testDb.db, 'user-1')).toBeNull();
  });

  it('returns IN_PROGRESS for a LOADING node with a locked request', async () => {
    const scenario = await seedFocalScenario(testDb.db, { upstreamState: 'LOADING' });
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'LOCKED',
      lockedBy: 'w1',
    });

    const result = await requestExpansion(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      userId: 'user-1',
    });
    expect(result).toEqual({ outcome: 'IN_PROGRESS', requestId });
  });

  it('queues a new request for an UNEXPANDED node and charges quota once', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const result = await requestExpansion(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      userId: 'user-1',
    });
    expect(result.outcome).toBe('QUEUED');

    const state = await readNodeState(testDb, scenario.nodeId);
    expect(state?.upstreamState).toBe('QUEUED');

    const quota = await getUserQuota(testDb.db, 'user-1');
    expect(quota?.expansionsToday).toBe(1);
  });

  it('queues a retry for a FAILED node and charges quota', async () => {
    const scenario = await seedFocalScenario(testDb.db, { upstreamState: 'FAILED' });
    const result = await requestExpansion(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      userId: 'user-1',
    });
    expect(result.outcome).toBe('QUEUED');
    const quota = await getUserQuota(testDb.db, 'user-1');
    expect(quota?.expansionsToday).toBe(1);
  });

  it('rejects a node that is 7 hops from the nearest root', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const deep = await buildChain(scenario.nodeId, scenario.sourceDocumentId, 7);

    const result = await requestExpansion(testDb.db, {
      nodeId: deep,
      direction: 'UPSTREAM',
      userId: 'user-1',
    });
    expect(result.outcome).toBe('REJECTED');
    if (result.outcome === 'REJECTED') {
      expect(result.reason).toBe('DEPTH_LIMIT_REACHED');
    }
    expect(await getUserQuota(testDb.db, 'user-1')).toBeNull();
  });

  it('rejects when the user is at their daily limit', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    await ensureUserQuota(testDb.db, 'user-blocked', { dailyLimit: 0 });

    const result = await requestExpansion(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      userId: 'user-blocked',
    });
    expect(result.outcome).toBe('REJECTED');
    if (result.outcome === 'REJECTED') {
      expect(result.reason).toBe('QUOTA_EXCEEDED');
    }
    const quota = await getUserQuota(testDb.db, 'user-blocked');
    expect(quota?.expansionsToday).toBe(0);
  });

  it('rejects an unknown node', async () => {
    const result = await requestExpansion(testDb.db, {
      nodeId: '00000000-0000-0000-0000-000000000000',
      direction: 'UPSTREAM',
      userId: 'user-1',
    });
    expect(result).toMatchObject({ outcome: 'REJECTED', reason: 'NODE_NOT_FOUND' });
  });

  it('allows a root node (depth 0)', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const result = await requestExpansion(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      userId: 'user-1',
    });
    expect(result.outcome).toBe('QUEUED');
  });

  it('creates a UserQuota row for a first-time user', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    expect(await getUserQuota(testDb.db, 'first-timer')).toBeNull();
    await requestExpansion(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      userId: 'first-timer',
    });
    const quota = await getUserQuota(testDb.db, 'first-timer');
    expect(quota).not.toBeNull();
    expect(quota?.dailyLimit).toBe(20);
  });

  it('collapses a racing duplicate request onto the winner', async () => {
    const scenario = await seedFocalScenario(testDb.db);

    const [a, b] = await Promise.all([
      requestExpansion(testDb.db, {
        nodeId: scenario.nodeId,
        direction: 'UPSTREAM',
        userId: 'user-1',
      }),
      requestExpansion(testDb.db, {
        nodeId: scenario.nodeId,
        direction: 'UPSTREAM',
        userId: 'user-1',
      }),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['IN_PROGRESS', 'QUEUED']);

    // Exactly one quota unit was consumed (the loser refunded).
    const quota = await getUserQuota(testDb.db, 'user-1');
    expect(quota?.expansionsToday).toBe(1);
  });

  it('allows UPSTREAM and DOWNSTREAM requests for the same node', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const up = await requestExpansion(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      userId: 'user-1',
    });
    const down = await requestExpansion(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'DOWNSTREAM',
      userId: 'user-1',
    });
    expect(up.outcome).toBe('QUEUED');
    expect(down.outcome).toBe('QUEUED');
    if (up.outcome === 'QUEUED' && down.outcome === 'QUEUED') {
      expect(up.requestId).not.toBe(down.requestId);
    }
  });

  it('refunds quota when request creation loses a race', async () => {
    // An existing in-flight request plus an UNEXPANDED node forces the insert
    // to hit unique_inflight_expansion; the reservation must be refunded.
    const scenario = await seedFocalScenario(testDb.db);
    const existingId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'PENDING',
    });

    const result = await requestExpansion(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      userId: 'user-1',
    });
    expect(result).toEqual({ outcome: 'IN_PROGRESS', requestId: existingId });
    const quota = await getUserQuota(testDb.db, 'user-1');
    expect(quota?.expansionsToday).toBe(0);
  });

  it('computes depth 3 correctly and allows the request', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const deep = await buildChain(scenario.nodeId, scenario.sourceDocumentId, 3);

    const result = await requestExpansion(testDb.db, {
      nodeId: deep,
      direction: 'UPSTREAM',
      userId: 'user-1',
    });
    expect(result.outcome).toBe('QUEUED');
    if (result.outcome !== 'QUEUED') return;

    const [row] = await testDb.db
      .select({ depthFromRoot: expansionRequests.depthFromRoot })
      .from(expansionRequests)
      .where(eq(expansionRequests.id, result.requestId));
    expect(row?.depthFromRoot).toBe(3);
  });
});
