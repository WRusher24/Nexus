import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../../lib/db/schema';
import { edges, evidenceSpans } from '../../../lib/db/schema';
import { insertVerifiedEdgeBatch } from '../../../lib/graph/insertVerifiedEdge';
import type { EdgeInsertInput } from '../../../lib/graph/types';
import {
  captureError,
  closeTestDb,
  errorChainMessage,
  getPgErrorCode,
  getTestDatabaseUrl,
  getTestDb,
  resetTestDb,
  type TestDb,
} from '../../helpers/db';
import {
  edgeInsertSql,
  insertVerifiedEdgeThroughApp,
  makeEvidence,
} from '../../helpers/edgeHelper';
import {
  createTestFixtures,
  insertNode,
  uniqueQid,
  type TestFixtures,
} from '../../helpers/fixtures';

const CHECK_VIOLATION = '23514';

describe('insertVerifiedEdge (P1-P3)', () => {
  let testDb: TestDb;
  let fixtures: TestFixtures;

  beforeAll(async () => {
    testDb = await getTestDb();
  }, 60000);

  afterAll(async () => {
    await resetTestDb(testDb);
    await closeTestDb(testDb);
  });

  beforeEach(async () => {
    await resetTestDb(testDb);
    fixtures = await createTestFixtures(testDb.db);
  });

  /** Build a valid edge input with one evidence span by default. */
  function edgeInput(
    overrides: Partial<EdgeInsertInput> &
      Pick<EdgeInsertInput, 'causeNodeId' | 'effectNodeId'>,
  ): EdgeInsertInput {
    return {
      relationType: 'CAUSED',
      importanceRank: 5,
      contested: false,
      extractionRunId: fixtures.extractionRunId,
      evidence: [
        makeEvidence({
          sourceDocumentId: fixtures.sourceDocumentId,
          extractionRunId: fixtures.extractionRunId,
        }),
      ],
      ...overrides,
    };
  }

  it('creates an edge A -> B with one evidence span', async () => {
    const result = await insertVerifiedEdgeThroughApp(
      testDb.db,
      edgeInput({ causeNodeId: fixtures.nodeA, effectNodeId: fixtures.nodeB }),
    );

    expect(result.outcome).toBe('CREATED');
    if (result.outcome !== 'CREATED') return;
    expect(result.evidenceCount).toBe(1);
  });

  it('stores the edge as ACTIVE with chronologyStatus VERIFIED', async () => {
    const result = await insertVerifiedEdgeThroughApp(
      testDb.db,
      edgeInput({ causeNodeId: fixtures.nodeA, effectNodeId: fixtures.nodeB }),
    );
    if (result.outcome !== 'CREATED') throw new Error('expected CREATED');

    const [row] = await testDb.db
      .select()
      .from(edges)
      .where(eq(edges.id, result.edgeId));
    expect(row?.status).toBe('ACTIVE');
    expect(row?.chronologyStatus).toBe('VERIFIED');
  });

  it('stores the evidence span as VERIFIED with the supplied offsets', async () => {
    const evidence = makeEvidence(
      {
        sourceDocumentId: fixtures.sourceDocumentId,
        extractionRunId: fixtures.extractionRunId,
      },
      { quoteText: 'The source text supports the test', charOffsetStart: 0, charOffsetEnd: 32 },
    );
    const result = await insertVerifiedEdgeThroughApp(
      testDb.db,
      edgeInput({
        causeNodeId: fixtures.nodeA,
        effectNodeId: fixtures.nodeB,
        evidence: [evidence],
      }),
    );
    if (result.outcome !== 'CREATED') throw new Error('expected CREATED');

    const spans = await testDb.db
      .select()
      .from(evidenceSpans)
      .where(eq(evidenceSpans.edgeId, result.edgeId));
    expect(spans).toHaveLength(1);
    expect(spans[0]?.verificationStatus).toBe('VERIFIED');
    expect(spans[0]?.verificationMethod).toBe('exact_normalized_match');
    expect(spans[0]?.charOffsetStart).toBe(0);
    expect(spans[0]?.charOffsetEnd).toBe(32);
  });

  it('returns EXISTING and attaches new evidence to the existing edge', async () => {
    const input = edgeInput({
      causeNodeId: fixtures.nodeA,
      effectNodeId: fixtures.nodeB,
    });
    const first = await insertVerifiedEdgeThroughApp(testDb.db, input);
    const second = await insertVerifiedEdgeThroughApp(testDb.db, input);

    expect(first.outcome).toBe('CREATED');
    expect(second.outcome).toBe('EXISTING');
    if (first.outcome !== 'CREATED' || second.outcome !== 'EXISTING') return;
    expect(second.edgeId).toBe(first.edgeId);
    expect(second.newEvidenceCount).toBe(1);
  });

  it('accumulates a second evidence span on the existing edge', async () => {
    const input = edgeInput({
      causeNodeId: fixtures.nodeA,
      effectNodeId: fixtures.nodeB,
    });
    const first = await insertVerifiedEdgeThroughApp(testDb.db, input);
    await insertVerifiedEdgeThroughApp(testDb.db, input);
    if (first.outcome !== 'CREATED') throw new Error('expected CREATED');

    const spans = await testDb.db
      .select()
      .from(evidenceSpans)
      .where(eq(evidenceSpans.edgeId, first.edgeId));
    expect(spans).toHaveLength(2);
  });

  it('creates a separate edge for a different relationType', async () => {
    const base = {
      causeNodeId: fixtures.nodeA,
      effectNodeId: fixtures.nodeB,
    };
    const caused = await insertVerifiedEdgeThroughApp(
      testDb.db,
      edgeInput({ ...base, relationType: 'CAUSED' }),
    );
    const enabled = await insertVerifiedEdgeThroughApp(
      testDb.db,
      edgeInput({ ...base, relationType: 'ENABLED' }),
    );

    expect(caused.outcome).toBe('CREATED');
    expect(enabled.outcome).toBe('CREATED');
    if (caused.outcome !== 'CREATED' || enabled.outcome !== 'CREATED') return;
    expect(enabled.edgeId).not.toBe(caused.edgeId);
  });

  it('rejects a self-edge with reason SELF_EDGE', async () => {
    const result = await insertVerifiedEdgeThroughApp(
      testDb.db,
      edgeInput({ causeNodeId: fixtures.nodeA, effectNodeId: fixtures.nodeA }),
    );
    expect(result.outcome).toBe('REJECTED');
    if (result.outcome !== 'REJECTED') return;
    expect(result.reason).toBe('SELF_EDGE');
  });

  it('rejects an edge with no evidence with reason NO_EVIDENCE', async () => {
    const result = await insertVerifiedEdgeThroughApp(
      testDb.db,
      edgeInput({
        causeNodeId: fixtures.nodeA,
        effectNodeId: fixtures.nodeB,
        evidence: [],
      }),
    );
    expect(result.outcome).toBe('REJECTED');
    if (result.outcome !== 'REJECTED') return;
    expect(result.reason).toBe('NO_EVIDENCE');
  });

  it('rejects importanceRank 0', async () => {
    const result = await insertVerifiedEdgeThroughApp(
      testDb.db,
      edgeInput({
        causeNodeId: fixtures.nodeA,
        effectNodeId: fixtures.nodeB,
        importanceRank: 0,
      }),
    );
    expect(result.outcome).toBe('REJECTED');
    if (result.outcome !== 'REJECTED') return;
    expect(result.reason).toBe('IMPORTANCE_OUT_OF_RANGE');
  });

  it('rejects importanceRank 11', async () => {
    const result = await insertVerifiedEdgeThroughApp(
      testDb.db,
      edgeInput({
        causeNodeId: fixtures.nodeA,
        effectNodeId: fixtures.nodeB,
        importanceRank: 11,
      }),
    );
    expect(result.outcome).toBe('REJECTED');
    if (result.outcome !== 'REJECTED') return;
    expect(result.reason).toBe('IMPORTANCE_OUT_OF_RANGE');
  });

  it('rejects a reverse-chronology edge D -> A', async () => {
    const result = await insertVerifiedEdgeThroughApp(
      testDb.db,
      edgeInput({ causeNodeId: fixtures.nodeD, effectNodeId: fixtures.nodeA }),
    );
    expect(result.outcome).toBe('REJECTED');
    if (result.outcome !== 'REJECTED') return;
    expect(result.reason).toBe('CHRONOLOGY_VIOLATION');
  });

  it('creates an edge between UNKNOWN-dated nodes with chronologyStatus UNVERIFIED', async () => {
    const u1 = await insertNode(testDb.db, {
      identityScheme: 'WIKIDATA',
      wikidataQid: uniqueQid(),
      label: 'Unknown 1',
      nodeType: 'EVENT',
      dateStartPrecision: 'UNKNOWN',
    });
    const u2 = await insertNode(testDb.db, {
      identityScheme: 'WIKIDATA',
      wikidataQid: uniqueQid(),
      label: 'Unknown 2',
      nodeType: 'EVENT',
      dateStartPrecision: 'UNKNOWN',
    });

    const result = await insertVerifiedEdgeThroughApp(
      testDb.db,
      edgeInput({ causeNodeId: u1, effectNodeId: u2 }),
    );
    expect(result.outcome).toBe('CREATED');
    if (result.outcome !== 'CREATED') return;

    const [row] = await testDb.db
      .select()
      .from(edges)
      .where(eq(edges.id, result.edgeId));
    expect(row?.chronologyStatus).toBe('UNVERIFIED');
  });

  it('rejects C -> A after A -> B and B -> C (cycle)', async () => {
    await insertVerifiedEdgeThroughApp(
      testDb.db,
      edgeInput({ causeNodeId: fixtures.nodeA, effectNodeId: fixtures.nodeB }),
    );
    await insertVerifiedEdgeThroughApp(
      testDb.db,
      edgeInput({ causeNodeId: fixtures.nodeB, effectNodeId: fixtures.nodeC }),
    );

    const result = await insertVerifiedEdgeThroughApp(
      testDb.db,
      edgeInput({ causeNodeId: fixtures.nodeC, effectNodeId: fixtures.nodeA }),
    );
    expect(result.outcome).toBe('REJECTED');
    if (result.outcome !== 'REJECTED') return;
    expect(result.reason).toBe('CYCLE_DETECTED');
  });

  it('rejects B -> A after A -> B (two-node cycle)', async () => {
    await insertVerifiedEdgeThroughApp(
      testDb.db,
      edgeInput({ causeNodeId: fixtures.nodeA, effectNodeId: fixtures.nodeB }),
    );

    const result = await insertVerifiedEdgeThroughApp(
      testDb.db,
      edgeInput({ causeNodeId: fixtures.nodeB, effectNodeId: fixtures.nodeA }),
    );
    expect(result.outcome).toBe('REJECTED');
    if (result.outcome !== 'REJECTED') return;
    expect(result.reason).toBe('CYCLE_DETECTED');
  });

  it('the deferred P3 trigger aborts a raw ACTIVE edge with no evidence', async () => {
    const error = await captureError(() =>
      testDb.db.transaction(async (tx) => {
        await tx.execute(
          edgeInsertSql({
            causeNodeId: fixtures.nodeA,
            effectNodeId: fixtures.nodeB,
            extractionRunId: fixtures.extractionRunId,
          }),
        );
        // No evidence span: the deferred trigger fires at COMMIT.
      }),
    );

    expect(getPgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(errorChainMessage(error)).toMatch(/P3 VIOLATION/);
    const rows = await testDb.db.select().from(edges);
    expect(rows).toHaveLength(0);
  });

  it('batch: accepts three acyclic edges', async () => {
    const batch = await insertVerifiedEdgeBatch(testDb.db, [
      edgeInput({ causeNodeId: fixtures.nodeA, effectNodeId: fixtures.nodeB }),
      edgeInput({ causeNodeId: fixtures.nodeB, effectNodeId: fixtures.nodeC }),
      edgeInput({ causeNodeId: fixtures.nodeA, effectNodeId: fixtures.nodeC }),
    ]);

    expect(batch.rejected).toHaveLength(0);
    expect(batch.accepted).toHaveLength(3);
    expect(batch.accepted.every((entry) => entry.result.outcome === 'CREATED')).toBe(true);
  });

  it('batch: partitions one rejected cycle out of three', async () => {
    await insertVerifiedEdgeThroughApp(
      testDb.db,
      edgeInput({ causeNodeId: fixtures.nodeA, effectNodeId: fixtures.nodeB }),
    );
    await insertVerifiedEdgeThroughApp(
      testDb.db,
      edgeInput({ causeNodeId: fixtures.nodeB, effectNodeId: fixtures.nodeC }),
    );

    const batch = await insertVerifiedEdgeBatch(testDb.db, [
      edgeInput({ causeNodeId: fixtures.nodeA, effectNodeId: fixtures.nodeD }),
      edgeInput({ causeNodeId: fixtures.nodeC, effectNodeId: fixtures.nodeA }),
      edgeInput({ causeNodeId: fixtures.nodeB, effectNodeId: fixtures.nodeD }),
    ]);

    expect(batch.accepted).toHaveLength(2);
    expect(batch.rejected).toHaveLength(1);
    expect(batch.rejected[0]?.result.outcome).toBe('REJECTED');
  });

  it('concurrent identical inserts yield one ACTIVE edge', async () => {
    const pool2 = new Pool({ connectionString: getTestDatabaseUrl(), max: 5 });
    const db2 = drizzle(pool2, { schema });
    try {
      const input = edgeInput({
        causeNodeId: fixtures.nodeA,
        effectNodeId: fixtures.nodeB,
      });

      const [r1, r2] = await Promise.all([
        insertVerifiedEdgeThroughApp(testDb.db, input),
        insertVerifiedEdgeThroughApp(db2, input),
      ]);

      const outcomes = [r1.outcome, r2.outcome].sort();
      expect(outcomes).toEqual(['CREATED', 'EXISTING']);

      const active = await testDb.db
        .select()
        .from(edges)
        .where(
          and(
            eq(edges.causeNodeId, fixtures.nodeA),
            eq(edges.effectNodeId, fixtures.nodeB),
            eq(edges.status, 'ACTIVE'),
          ),
        );
      expect(active).toHaveLength(1);
    } finally {
      await pool2.end();
    }
  });

  it('concurrent opposite edges: one CREATED, one CYCLE_DETECTED (retry path)', async () => {
    const pool2 = new Pool({ connectionString: getTestDatabaseUrl(), max: 5 });
    const db2 = drizzle(pool2, { schema });
    try {
      const forward = edgeInput({
        causeNodeId: fixtures.nodeA,
        effectNodeId: fixtures.nodeB,
      });
      const backward = edgeInput({
        causeNodeId: fixtures.nodeB,
        effectNodeId: fixtures.nodeA,
      });

      const [r1, r2] = await Promise.all([
        insertVerifiedEdgeThroughApp(testDb.db, forward),
        insertVerifiedEdgeThroughApp(db2, backward),
      ]);

      const outcomes = [r1.outcome, r2.outcome].sort();
      expect(outcomes).toEqual(['CREATED', 'REJECTED']);
      const rejected = [r1, r2].find((r) => r.outcome === 'REJECTED');
      expect(rejected && rejected.outcome === 'REJECTED' ? rejected.reason : null).toBe(
        'CYCLE_DETECTED',
      );

      const active = await testDb.db
        .select()
        .from(edges)
        .where(eq(edges.status, 'ACTIVE'));
      expect(active).toHaveLength(1);
    } finally {
      await pool2.end();
    }
  });
});
