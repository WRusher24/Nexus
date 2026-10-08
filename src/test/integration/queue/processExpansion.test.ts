import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  edges,
  expansionRequests,
  extractionRuns,
  globalBudget,
  nodes,
} from '../../../lib/db/schema';
import type { SectionIndexEntry } from '../../../lib/db/schema';
import { LlmError } from '../../../lib/extraction/provider';
import type { ExtractionConfig } from '../../../lib/extraction/types';
import { claimNextRequest } from '../../../lib/queue/claim';
import {
  processExpansion,
  releaseLeaseAfterError,
} from '../../../lib/queue/processExpansion';
import { getUserQuota } from '../../../lib/queue/quota';
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
import { createLlmFixtureStore, fixtureResponse } from '../../helpers/llmFixture';
import {
  createStubResolver,
  createStubSourceDocumentService,
  createUnusedWikidataClient,
  createUnusedWikipediaClient,
  extractionOutput,
  proposedEdge,
} from '../../fixtures/extraction/harness';
import {
  buildFixtureConfig,
  DEFAULT_RESOLVER_MAP,
  insertExpansionRequest,
  richOutput,
  seedFocalScenario,
} from '../../helpers/workerHarness';

const Q_AS =
  'The assassination of Archduke Franz Ferdinand of Austria on 28 June 1914 triggered the July Crisis.';
const Q_AL = 'The alliance system drew the great powers into war.';
const Q_MI = 'Militarism and imperial rivalry created the underlying conditions.';

function fiveEdgeOutput() {
  return extractionOutput({
    focalName: 'World War I',
    edges: [
      proposedEdge({
        verbatimQuote: Q_AS,
        relationType: 'TRIGGERED',
        importanceRank: 1,
        relatedEntity: {
          name: 'Assassination of Archduke Franz Ferdinand',
          dateStart: { year: 1914, month: 6, day: 28, precision: 'DAY' },
        },
      }),
      proposedEdge({
        verbatimQuote: Q_AL,
        relationType: 'ENABLED',
        importanceRank: 2,
        relatedEntity: {
          name: 'European alliance system',
          dateStart: { year: 1879, month: null, day: null, precision: 'YEAR' },
        },
      }),
      proposedEdge({
        verbatimQuote: Q_MI,
        relationType: 'CONTRIBUTED_TO',
        importanceRank: 3,
        relatedEntity: {
          name: 'Militarism',
          dateStart: { year: 1880, month: null, day: null, precision: 'YEAR' },
        },
      }),
      proposedEdge({
        verbatimQuote: Q_AS,
        relationType: 'INFLUENCED',
        importanceRank: 4,
        relatedEntity: {
          name: 'Assassination of Archduke Franz Ferdinand',
          dateStart: { year: 1914, month: 6, day: 28, precision: 'DAY' },
        },
      }),
      proposedEdge({
        verbatimQuote: Q_AL,
        relationType: 'INFLUENCED',
        importanceRank: 5,
        relatedEntity: {
          name: 'European alliance system',
          dateStart: { year: 1879, month: null, day: null, precision: 'YEAR' },
        },
      }),
    ],
  });
}

function throwingConfig(
  scenario: { sourceDocumentId: string; rawText: string; sectionIndex: SectionIndexEntry[] },
  error: LlmError,
  rich: boolean,
): ExtractionConfig {
  const store = createLlmFixtureStore();
  store.register({
    promptHash: '*',
    response: fixtureResponse(
      rich ? richOutput() : extractionOutput({ edges: [] }),
    ),
    throwError: error,
  });
  return {
    provider: store.buildProvider(),
    sourceDocumentService: createStubSourceDocumentService({
      id: scenario.sourceDocumentId,
      rawText: scenario.rawText,
      sectionIndex: scenario.sectionIndex,
      wikipediaPageId: 30030,
      wikipediaTitle: 'Scenario',
    }),
    resolver: createStubResolver(DEFAULT_RESOLVER_MAP),
    wikipedia: createUnusedWikipediaClient(),
    wikidata: createUnusedWikidataClient(),
  };
}

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

describe('queue/processExpansion', () => {
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

  it('completes a rich extraction, marks the node EXPANDED, and records the run', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const queued = await requestExpansion(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      userId: 'user-1',
    });
    expect(queued.outcome).toBe('QUEUED');

    const claimed = await claimNextRequest(testDb.db, { workerId: 'w1' });
    expect(claimed).not.toBeNull();
    if (!claimed) return;

    const result = await processExpansion(testDb.db, {
      claimed,
      config: buildFixtureConfig(scenario, richOutput()),
    });
    expect(result).toMatchObject({ outcome: 'COMPLETED', finalState: 'EXPANDED' });
    if (result.outcome !== 'COMPLETED') return;

    expect(await readUpstreamState(testDb, scenario.nodeId)).toBe('EXPANDED');
    const runs = await testDb.db
      .select()
      .from(extractionRuns)
      .where(eq(extractionRuns.id, result.extractionRunId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('COMPLETED');

    const request = await readRequest(testDb, claimed.id);
    expect(request?.status).toBe('COMPLETED');
    expect(request?.leaseExpiresAt).toBeNull();
  });

  it('marks a zero-edge extraction as SPARSE', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const queued = await requestExpansion(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      userId: 'user-1',
    });
    if (queued.outcome !== 'QUEUED') throw new Error('expected queued');

    const claimed = await claimNextRequest(testDb.db, { workerId: 'w1' });
    if (!claimed) throw new Error('expected claim');

    const result = await processExpansion(testDb.db, {
      claimed,
      config: buildFixtureConfig(scenario, extractionOutput({ edges: [] })),
    });
    expect(result).toMatchObject({ outcome: 'COMPLETED', finalState: 'SPARSE' });
    expect(await readUpstreamState(testDb, scenario.nodeId)).toBe('SPARSE');
  });

  it('fails on ABORTED_BUDGET and refunds the user quota', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const queued = await requestExpansion(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      userId: 'user-1',
    });
    if (queued.outcome !== 'QUEUED') throw new Error('expected queued');

    await testDb.db
      .update(globalBudget)
      .set({ dailyBudgetUsd: 0, spentTodayUsd: 0 })
      .where(eq(globalBudget.id, 'singleton'));

    const claimed = await claimNextRequest(testDb.db, { workerId: 'w1' });
    if (!claimed) throw new Error('expected claim');

    const result = await processExpansion(testDb.db, {
      claimed,
      config: buildFixtureConfig(scenario, richOutput()),
    });
    expect(result.outcome).toBe('FAILED');
    expect(await readUpstreamState(testDb, scenario.nodeId)).toBe('FAILED');

    const q = await getUserQuota(testDb.db, 'user-1');
    expect(q?.expansionsToday).toBe(0);
  });

  it('fails on ABORTED_NO_SOURCE and refunds the user quota', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    // A child node with a generated identity and no Wikipedia source.
    const child = await insertNode(testDb.db, {
      identityScheme: 'NEXUS_GENERATED',
      nexusGeneratedId: `nexus_${uniqueQid()}`,
      label: 'Sourceless child',
      nodeType: 'EVENT',
    });
    const runId = await insertExtractionRun(testDb.db, {
      focalNodeId: scenario.nodeId,
      sourceDocumentId: scenario.sourceDocumentId,
    });
    const input: EdgeInsertInput = {
      causeNodeId: scenario.nodeId,
      effectNodeId: child,
      relationType: 'CAUSED',
      importanceRank: 5,
      contested: false,
      extractionRunId: runId,
      evidence: [makeEvidence({ sourceDocumentId: scenario.sourceDocumentId, extractionRunId: runId })],
    };
    const linked = await insertVerifiedEdgeThroughApp(testDb.db, input);
    expect(linked.outcome).not.toBe('REJECTED');

    const queued = await requestExpansion(testDb.db, {
      nodeId: child,
      direction: 'UPSTREAM',
      userId: 'user-1',
    });
    if (queued.outcome !== 'QUEUED') throw new Error(`expected queued, got ${queued.outcome}`);

    const claimed = await claimNextRequest(testDb.db, { workerId: 'w1' });
    if (!claimed) throw new Error('expected claim');

    const result = await processExpansion(testDb.db, {
      claimed,
      config: buildFixtureConfig(scenario, extractionOutput({ edges: [] })),
    });
    expect(result.outcome).toBe('FAILED');
    const q = await getUserQuota(testDb.db, 'user-1');
    expect(q?.expansionsToday).toBe(0);
  });

  it('schedules a retry on a retryable failure and does NOT refund quota', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const queued = await requestExpansion(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      userId: 'user-1',
    });
    if (queued.outcome !== 'QUEUED') throw new Error('expected queued');

    const claimed = await claimNextRequest(testDb.db, { workerId: 'w1' });
    if (!claimed) throw new Error('expected claim');

    const result = await processExpansion(testDb.db, {
      claimed,
      config: throwingConfig(scenario, new LlmError('NETWORK_ERROR', 'reset', true), true),
    });
    expect(result.outcome).toBe('RETRY_SCHEDULED');

    const request = await readRequest(testDb, claimed.id);
    expect(request?.status).toBe('PENDING');
    expect(request?.retryAfter).not.toBeNull();
    expect(await readUpstreamState(testDb, scenario.nodeId)).toBe('QUEUED');

    const q = await getUserQuota(testDb.db, 'user-1');
    expect(q?.expansionsToday).toBe(1);
  });

  it('fails when a retryable error exhausts the attempt budget', async () => {
    const scenario = await seedFocalScenario(testDb.db, { upstreamState: 'QUEUED' });
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'PENDING',
      attempt: 2, // claim makes it 3 = MAX_ATTEMPTS
    });

    const claimed = await claimNextRequest(testDb.db, { workerId: 'w1' });
    if (!claimed) throw new Error('expected claim');
    expect(claimed.attempt).toBe(3);

    const result = await processExpansion(testDb.db, {
      claimed,
      config: throwingConfig(scenario, new LlmError('NETWORK_ERROR', 'reset', true), true),
    });
    expect(result.outcome).toBe('FAILED');

    const request = await readRequest(testDb, requestId);
    expect(request?.status).toBe('FAILED');
    expect(await readUpstreamState(testDb, scenario.nodeId)).toBe('FAILED');
  });

  it('fails immediately on a non-retryable error', async () => {
    const scenario = await seedFocalScenario(testDb.db, { upstreamState: 'QUEUED' });
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'PENDING',
      attempt: 0,
    });

    const claimed = await claimNextRequest(testDb.db, { workerId: 'w1' });
    if (!claimed) throw new Error('expected claim');

    const result = await processExpansion(testDb.db, {
      claimed,
      config: throwingConfig(
        scenario,
        new LlmError('SCHEMA_MISMATCH', 'bad shape', false),
        true,
      ),
    });
    expect(result.outcome).toBe('FAILED');
    expect((await readRequest(testDb, requestId))?.status).toBe('FAILED');
  });

  it('clears the lease after successful processing (heartbeat stopped)', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const queued = await requestExpansion(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      userId: 'user-1',
    });
    if (queued.outcome !== 'QUEUED') throw new Error('expected queued');

    const claimed = await claimNextRequest(testDb.db, { workerId: 'w1' });
    if (!claimed) throw new Error('expected claim');

    await processExpansion(testDb.db, {
      claimed,
      config: buildFixtureConfig(scenario, richOutput()),
    });

    const request = await readRequest(testDb, claimed.id);
    expect(request?.leaseExpiresAt).toBeNull();
    expect(request?.lockedBy).toBeNull();

    // Give any stray heartbeat a chance to (incorrectly) fire; the lease must
    // stay null because the request is no longer in flight.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((await readRequest(testDb, claimed.id))?.leaseExpiresAt).toBeNull();
  });

  it('releases the lease when processing cannot continue', async () => {
    const scenario = await seedFocalScenario(testDb.db, { upstreamState: 'QUEUED' });
    const requestId = await insertExpansionRequest(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      status: 'PENDING',
      attempt: 0,
    });
    const claimed = await claimNextRequest(testDb.db, { workerId: 'w1' });
    if (!claimed) throw new Error('expected claim');

    await releaseLeaseAfterError(testDb.db, claimed);
    const request = await readRequest(testDb, requestId);
    expect(request?.status).toBe('PENDING');
    expect(request?.retryAfter).not.toBeNull();
  });

  it('persists five verified edges through the full stack', async () => {
    const scenario = await seedFocalScenario(testDb.db);
    const queued = await requestExpansion(testDb.db, {
      nodeId: scenario.nodeId,
      direction: 'UPSTREAM',
      userId: 'user-1',
    });
    if (queued.outcome !== 'QUEUED') throw new Error('expected queued');

    const claimed = await claimNextRequest(testDb.db, { workerId: 'w1' });
    if (!claimed) throw new Error('expected claim');

    const result = await processExpansion(testDb.db, {
      claimed,
      config: buildFixtureConfig(scenario, fiveEdgeOutput()),
    });
    expect(result).toMatchObject({ outcome: 'COMPLETED', finalState: 'EXPANDED' });
    if (result.outcome !== 'COMPLETED') return;

    const persisted = await testDb.db
      .select()
      .from(edges)
      .where(eq(edges.firstExtractionRunId, result.extractionRunId));
    expect(persisted).toHaveLength(5);
    expect(persisted.every((edge) => edge.status === 'ACTIVE')).toBe(true);
  });
});
