import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { edges, evidenceSpans } from '../../lib/db/schema';
import {
  captureError,
  closeTestDb,
  errorChainMessage,
  getPgErrorCode,
  getTestDb,
  resetTestDb,
  type TestDb,
} from '../helpers/db';
import { edgeInsertSql, insertEdgeWithEvidence } from '../helpers/edgeHelper';
import { createTestFixtures, type TestFixtures } from '../helpers/fixtures';

const CHECK_VIOLATION = '23514';

describe('P3: evidence constraint', () => {
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

  it('accepts an ACTIVE edge with a VERIFIED evidence span in the same transaction', async () => {
    const edgeId = await insertEdgeWithEvidence(testDb.db, {
      causeNodeId: fixtures.nodeA,
      effectNodeId: fixtures.nodeB,
      extractionRunId: fixtures.extractionRunId,
      sourceDocumentId: fixtures.sourceDocumentId,
      evidenceStatus: 'VERIFIED',
    });

    const spans = await testDb.db
      .select()
      .from(evidenceSpans)
      .where(eq(evidenceSpans.edgeId, edgeId));
    expect(spans).toHaveLength(1);
    expect(spans[0]?.verificationStatus).toBe('VERIFIED');
  });

  it('rejects an ACTIVE edge with no evidence span at COMMIT (trg_edge_evidence)', async () => {
    const error = await captureError(() =>
      testDb.db.transaction(async (tx) => {
        await tx.execute(
          edgeInsertSql({
            causeNodeId: fixtures.nodeA,
            effectNodeId: fixtures.nodeB,
            extractionRunId: fixtures.extractionRunId,
          }),
        );
        // No evidence span inserted: the deferred trigger must fire at COMMIT.
      }),
    );

    expect(getPgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(errorChainMessage(error)).toMatch(/P3 VIOLATION/);
    const rows = await testDb.db.select().from(edges);
    expect(rows).toHaveLength(0);
  });

  it('rejects an ACTIVE edge whose only evidence is NOT_FOUND', async () => {
    const error = await captureError(() =>
      insertEdgeWithEvidence(testDb.db, {
        causeNodeId: fixtures.nodeA,
        effectNodeId: fixtures.nodeB,
        extractionRunId: fixtures.extractionRunId,
        sourceDocumentId: fixtures.sourceDocumentId,
        evidenceStatus: 'NOT_FOUND',
      }),
    );

    expect(getPgErrorCode(error)).toBe(CHECK_VIOLATION);
    const rows = await testDb.db.select().from(edges);
    expect(rows).toHaveLength(0);
  });

  it('does NOT catch evidence deleted after the edge was committed (KNOWN GAP)', async () => {
    const edgeId = await insertEdgeWithEvidence(testDb.db, {
      causeNodeId: fixtures.nodeA,
      effectNodeId: fixtures.nodeB,
      extractionRunId: fixtures.extractionRunId,
      sourceDocumentId: fixtures.sourceDocumentId,
    });

    // KNOWN GAP: trigger only fires on Edge insert/update, not on EvidenceSpan
    // deletion. Mitigated by P4 (no DELETE) and audit query 5. Deleting the
    // evidence therefore succeeds, leaving an ACTIVE edge with no evidence.
    await testDb.db.execute(
      sql`DELETE FROM "evidenceSpans" WHERE "edgeId" = ${edgeId}`,
    );

    const spans = await testDb.db
      .select()
      .from(evidenceSpans)
      .where(eq(evidenceSpans.edgeId, edgeId));
    expect(spans).toHaveLength(0);

    const [row] = await testDb.db
      .select()
      .from(edges)
      .where(eq(edges.id, edgeId));
    expect(row?.status).toBe('ACTIVE');

    // The defence-in-depth audit query catches it (this is the whole point of
    // audit 5).
    const missing = await testDb.db.execute<{ violations: number }>(sql`
      SELECT COUNT(*)::int AS violations
      FROM "edges" e
      WHERE e."status" = 'ACTIVE'
        AND NOT EXISTS (
          SELECT 1 FROM "evidenceSpans" es
          WHERE es."edgeId" = e."id"
            AND es."verificationStatus" = 'VERIFIED'
        )
    `);
    expect(missing.rows[0]?.violations).toBe(1);
  });

  it('accepts a SUPERSEDED edge with no evidence span', async () => {
    const result = await testDb.db.transaction(async (tx) => {
      return tx.execute(
        edgeInsertSql({
          causeNodeId: fixtures.nodeA,
          effectNodeId: fixtures.nodeB,
          extractionRunId: fixtures.extractionRunId,
          status: 'SUPERSEDED',
        }),
      );
    });

    expect(result.rows).toHaveLength(1);
    const rows = await testDb.db.select().from(edges);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('SUPERSEDED');
  });
});
