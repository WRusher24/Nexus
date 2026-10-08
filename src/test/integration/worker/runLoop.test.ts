import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  expansionRequests,
  nodes,
} from '../../../lib/db/schema';
import type { Database } from '../../../lib/graph/types';
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
  buildSlowFixtureConfig,
  insertExpansionRequest,
  richOutput,
  seedFocalScenario,
  waitFor,
} from '../../helpers/workerHarness';

async function countCompleted(testDb: TestDb): Promise<number> {
  const rows = await testDb.db
    .select({ id: expansionRequests.id })
    .from(expansionRequests)
    .where(eq(expansionRequests.status, 'COMPLETED'));
  return rows.length;
}

async function readStatus(testDb: TestDb, id: string): Promise<string | null> {
  const [row] = await testDb.db
    .select({ status: expansionRequests.status })
    .from(expansionRequests)
    .where(eq(expansionRequests.id, id));
  return row?.status ?? null;
}

async function readNodeState(testDb: TestDb, nodeId: string) {
  const [row] = await testDb.db
    .select({ upstreamState: nodes.upstreamState })
    .from(nodes)
    .where(eq(nodes.id, nodeId));
  return row?.upstreamState;
}

/** A Database proxy that fails the first N `transaction` calls. */
function makeFlakyDb(target: Database, failures: number): { db: Database; getErrors: () => number } {
  let remaining = failures;
  let observed = 0;
  const proxy = new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (prop === 'transaction' && typeof value === 'function') {
        return (...args: unknown[]) => {
          if (remaining > 0) {
            remaining -= 1;
            observed += 1;
            return Promise.reject(new Error('connection lost'));
          }
          return (value as (...a: unknown[]) => unknown).apply(obj, args);
        };
      }
      if (typeof value === 'function') return value.bind(obj);
      return value;
    },
  }) as Database;
  return { db: proxy, getErrors: () => observed };
}

describe('worker/runLoop', () => {
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

  it('processes three pending requests and then idles', async () => {
    const scenarios = [];
    for (let i = 0; i < 3; i += 1) {
      const scenario = await seedFocalScenario(testDb.db, { label: `Focal ${i}` });
      const queued = await requestExpansion(testDb.db, {
        nodeId: scenario.nodeId,
        direction: 'UPSTREAM',
        userId: 'user-1',
      });
      expect(queued.outcome).toBe('QUEUED');
      scenarios.push(scenario);
    }
    const config = buildFixtureConfig(scenarios[0]!, richOutput());

    const controller = new AbortController();
    const loop = runWorkerLoop(testDb.db, {
      workerId: 'w1',
      config,
      pollIntervalSeconds: 0.05,
      reaperIntervalSeconds: 10,
      signal: controller.signal,
    });

    await waitFor(async () => (await countCompleted(testDb)) === 3, { timeoutMs: 8000 });
    controller.abort();
    await loop;

    for (const scenario of scenarios) {
      expect(await readNodeState(testDb, scenario.nodeId)).toBe('EXPANDED');
    }
  });

  it('responds to an abort signal within 2 seconds while idle', async () => {
    const config = buildFixtureConfig(await seedFocalScenario(testDb.db), richOutput());
    const controller = new AbortController();
    const loop = runWorkerLoop(testDb.db, {
      workerId: 'w1',
      config,
      pollIntervalSeconds: 0.05,
      reaperIntervalSeconds: 10,
      signal: controller.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const startedAbort = Date.now();
    controller.abort();
    await loop;
    expect(Date.now() - startedAbort).toBeLessThan(2000);
  });

  it('waits for an in-flight request to finish before shutting down', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const queued = await requestExpansion(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      userId: 'user-1',
    });
    if (queued.outcome !== 'QUEUED') throw new Error('expected queued');

    const config = buildSlowFixtureConfig(scenario, richOutput(), 400);
    const controller = new AbortController();
    let processed = false;
    const loop = runWorkerLoop(testDb.db, {
      workerId: 'w1',
      config,
      pollIntervalSeconds: 0.05,
      reaperIntervalSeconds: 10,
      signal: controller.signal,
      onProcessed: () => {
        processed = true;
      },
    });

    // Abort once processing has started.
    await waitFor(async () => (await readStatus(testDb, queued.requestId)) === 'EXTRACTING', {
      timeoutMs: 8000,
    });
    controller.abort();
    await loop;

    expect(processed).toBe(true);
    expect(await readStatus(testDb, queued.requestId)).toBe('COMPLETED');
  });

  it('reclaims stale leases on its reaper interval', async () => {
    const scenario = await seedFocalScenario(testDb.db, { upstreamState: 'LOADING' });
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'EXTRACTING',
      attempt: 1,
      lockedBy: 'dead-worker',
      leaseExpiresAt: new Date(Date.now() - 60_000),
    });

    const config = buildFixtureConfig(scenario, richOutput());
    const controller = new AbortController();
    const loop = runWorkerLoop(testDb.db, {
      workerId: 'w1',
      config,
      pollIntervalSeconds: 0.05,
      reaperIntervalSeconds: 0.05,
      signal: controller.signal,
    });

    await waitFor(async () => (await readStatus(testDb, requestId)) === 'PENDING', {
      timeoutMs: 5000,
    });
    controller.abort();
    await loop;

    // It stays PENDING because the reaper set a 30s backoff.
    expect(await readStatus(testDb, requestId)).toBe('PENDING');
  });

  it('never lets two concurrent loops claim the same request', async () => {
    const scenarios = [];
    for (let i = 0; i < 2; i += 1) {
      const scenario = await seedFocalScenario(testDb.db, { label: `Focal ${i}` });
      await requestExpansion(testDb.db, {
        nodeId: scenario.nodeId,
        direction: 'UPSTREAM',
        userId: 'user-1',
      });
      scenarios.push(scenario);
    }
    const config = buildFixtureConfig(scenarios[0]!, richOutput());

    const processedIds: string[] = [];
    const c1 = new AbortController();
    const c2 = new AbortController();
    const loop1 = runWorkerLoop(testDb.db, {
      workerId: 'w1',
      config,
      pollIntervalSeconds: 0.05,
      reaperIntervalSeconds: 10,
      signal: c1.signal,
      onProcessed: (id) => processedIds.push(id),
    });
    const loop2 = runWorkerLoop(testDb.db, {
      workerId: 'w2',
      config,
      pollIntervalSeconds: 0.05,
      reaperIntervalSeconds: 10,
      signal: c2.signal,
      onProcessed: (id) => processedIds.push(id),
    });

    await waitFor(async () => (await countCompleted(testDb)) === 2, { timeoutMs: 8000 });
    c1.abort();
    c2.abort();
    await Promise.all([loop1, loop2]);

    expect(processedIds).toHaveLength(2);
    expect(new Set(processedIds).size).toBe(2);
  });

  it('logs and retries after a transient database connection error', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    await requestExpansion(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      userId: 'user-1',
    });

    const flaky = makeFlakyDb(testDb.db, 1);
    const errors: string[] = [];
    const controller = new AbortController();
    const loop = runWorkerLoop(flaky.db, {
      workerId: 'w1',
      config: buildFixtureConfig(scenario, richOutput()),
      pollIntervalSeconds: 0.05,
      reaperIntervalSeconds: 10,
      signal: controller.signal,
      onError: (_error, stage) => errors.push(stage),
    });

    await waitFor(async () => (await countCompleted(testDb)) === 1, { timeoutMs: 8000 });
    controller.abort();
    await loop;

    expect(errors).toContain('claim');
    expect(flaky.getErrors()).toBe(1);
  });
});
