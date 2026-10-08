import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { edges } from '../../lib/db/schema';
import {
  captureError,
  closeTestDb,
  getPgErrorCode,
  getTestDb,
  resetTestDb,
  type TestDb,
} from '../helpers/db';
import { insertEdgeWithEvidence } from '../helpers/edgeHelper';
import { createTestFixtures, type TestFixtures } from '../helpers/fixtures';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

describe('P2: acyclicity and edge constraints', () => {
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

  it('inserts edge A -> B (cause precedes effect)', async () => {
    const edgeId = await insertEdgeWithEvidence(testDb.db, {
      causeNodeId: fixtures.nodeA,
      effectNodeId: fixtures.nodeB,
      extractionRunId: fixtures.extractionRunId,
      sourceDocumentId: fixtures.sourceDocumentId,
    });

    const [row] = await testDb.db
      .select()
      .from(edges)
      .where(eq(edges.id, edgeId));
    expect(row?.causeNodeId).toBe(fixtures.nodeA);
    expect(row?.effectNodeId).toBe(fixtures.nodeB);
    expect(row?.status).toBe('ACTIVE');
  });

  it('rejects a self-referential edge (chk_no_self_edge)', async () => {
    const error = await captureError(() =>
      insertEdgeWithEvidence(testDb.db, {
        causeNodeId: fixtures.nodeA,
        effectNodeId: fixtures.nodeA,
        extractionRunId: fixtures.extractionRunId,
        sourceDocumentId: fixtures.sourceDocumentId,
      }),
    );

    expect(getPgErrorCode(error)).toBe(CHECK_VIOLATION);
    const rows = await testDb.db.select().from(edges);
    expect(rows).toHaveLength(0);
  });

  it('rejects an edge with importanceRank = 0 (chk_importance_range)', async () => {
    const error = await captureError(() =>
      insertEdgeWithEvidence(testDb.db, {
        causeNodeId: fixtures.nodeA,
        effectNodeId: fixtures.nodeB,
        extractionRunId: fixtures.extractionRunId,
        sourceDocumentId: fixtures.sourceDocumentId,
        importanceRank: 0,
      }),
    );

    expect(getPgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('rejects an edge with importanceRank = 11 (chk_importance_range)', async () => {
    const error = await captureError(() =>
      insertEdgeWithEvidence(testDb.db, {
        causeNodeId: fixtures.nodeA,
        effectNodeId: fixtures.nodeB,
        extractionRunId: fixtures.extractionRunId,
        sourceDocumentId: fixtures.sourceDocumentId,
        importanceRank: 11,
      }),
    );

    expect(getPgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('accepts an edge with importanceRank = 5', async () => {
    const edgeId = await insertEdgeWithEvidence(testDb.db, {
      causeNodeId: fixtures.nodeA,
      effectNodeId: fixtures.nodeB,
      extractionRunId: fixtures.extractionRunId,
      sourceDocumentId: fixtures.sourceDocumentId,
      importanceRank: 5,
    });

    const [row] = await testDb.db
      .select()
      .from(edges)
      .where(eq(edges.id, edgeId));
    expect(row?.importanceRank).toBe(5);
  });

  it('rejects a second ACTIVE edge for the same (cause, effect, relationType)', async () => {
    await insertEdgeWithEvidence(testDb.db, {
      causeNodeId: fixtures.nodeA,
      effectNodeId: fixtures.nodeB,
      extractionRunId: fixtures.extractionRunId,
      sourceDocumentId: fixtures.sourceDocumentId,
      relationType: 'CAUSED',
    });

    const error = await captureError(() =>
      insertEdgeWithEvidence(testDb.db, {
        causeNodeId: fixtures.nodeA,
        effectNodeId: fixtures.nodeB,
        extractionRunId: fixtures.extractionRunId,
        sourceDocumentId: fixtures.sourceDocumentId,
        relationType: 'CAUSED',
      }),
    );

    expect(getPgErrorCode(error)).toBe(UNIQUE_VIOLATION);
    const rows = await testDb.db
      .select()
      .from(edges)
      .where(eq(edges.causeNodeId, fixtures.nodeA));
    expect(rows).toHaveLength(1);
  });

  it('allows one ACTIVE and one SUPERSEDED edge for the same triple', async () => {
    await insertEdgeWithEvidence(testDb.db, {
      causeNodeId: fixtures.nodeA,
      effectNodeId: fixtures.nodeB,
      extractionRunId: fixtures.extractionRunId,
      sourceDocumentId: fixtures.sourceDocumentId,
      relationType: 'CAUSED',
      status: 'ACTIVE',
    });
    await insertEdgeWithEvidence(testDb.db, {
      causeNodeId: fixtures.nodeA,
      effectNodeId: fixtures.nodeB,
      extractionRunId: fixtures.extractionRunId,
      sourceDocumentId: fixtures.sourceDocumentId,
      relationType: 'CAUSED',
      status: 'SUPERSEDED',
    });

    const rows = await testDb.db
      .select()
      .from(edges)
      .where(eq(edges.causeNodeId, fixtures.nodeA));
    expect(rows).toHaveLength(2);
    const statuses = rows.map((r) => r.status).sort();
    expect(statuses).toEqual(['ACTIVE', 'SUPERSEDED']);
  });

  it('allows two ACTIVE edges with the same pair but different relationType', async () => {
    await insertEdgeWithEvidence(testDb.db, {
      causeNodeId: fixtures.nodeA,
      effectNodeId: fixtures.nodeB,
      extractionRunId: fixtures.extractionRunId,
      sourceDocumentId: fixtures.sourceDocumentId,
      relationType: 'CAUSED',
    });
    await insertEdgeWithEvidence(testDb.db, {
      causeNodeId: fixtures.nodeA,
      effectNodeId: fixtures.nodeB,
      extractionRunId: fixtures.extractionRunId,
      sourceDocumentId: fixtures.sourceDocumentId,
      relationType: 'ENABLED',
    });

    const rows = await testDb.db
      .select()
      .from(edges)
      .where(
        and(
          eq(edges.causeNodeId, fixtures.nodeA),
          eq(edges.effectNodeId, fixtures.nodeB),
        ),
      );
    expect(rows).toHaveLength(2);
  });
});
