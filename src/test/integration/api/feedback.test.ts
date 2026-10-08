import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { edgeFeedback, edges } from '../../../lib/db/schema';
import {
  callApi,
  insertTestUser,
  setTestDb,
} from '../../helpers/apiClient';
import {
  closeTestDb,
  getTestDb,
  resetTestDb,
  type TestDb,
} from '../../helpers/db';
import { createTestFixtures } from '../../helpers/fixtures';
import {
  insertVerifiedEdgeThroughApp,
  makeEvidence,
} from '../../helpers/edgeHelper';

describe('POST /api/edges/{id}/feedback', () => {
  let testDb: TestDb;
  let edgeId: string;

  beforeAll(async () => {
    testDb = await getTestDb();
  }, 60000);

  afterAll(async () => {
    await closeTestDb(testDb);
  });

  beforeEach(async () => {
    await resetTestDb(testDb);
    setTestDb(testDb.db);
    const fixtures = await createTestFixtures(testDb.db);
    const result = await insertVerifiedEdgeThroughApp(testDb.db, {
      causeNodeId: fixtures.nodeA,
      effectNodeId: fixtures.nodeB,
      relationType: 'CAUSED',
      importanceRank: 1,
      contested: false,
      extractionRunId: fixtures.extractionRunId,
      evidence: [
        makeEvidence({
          sourceDocumentId: fixtures.sourceDocumentId,
          extractionRunId: fixtures.extractionRunId,
        }),
      ],
    });
    if (result.outcome === 'REJECTED') {
      throw new Error(`failed to seed edge: ${result.detail}`);
    }
    edgeId = result.edgeId;
  });

  it('stores feedback and returns 201', async () => {
    const userId = await insertTestUser(testDb.db);
    const response = await callApi(`/api/edges/${edgeId}/feedback`, {
      method: 'POST',
      session: { userId },
      body: { type: 'INCORRECT', note: 'not a cause' },
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { autoHidden: boolean };
    expect(body.autoHidden).toBe(false);

    const rows = await testDb.db
      .select()
      .from(edgeFeedback)
      .where(eq(edgeFeedback.edgeId, edgeId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('INCORRECT');
  });

  it('auto-hides the edge after two distinct users report INCORRECT', async () => {
    const userA = await insertTestUser(testDb.db);
    const userB = await insertTestUser(testDb.db);

    const first = await callApi(`/api/edges/${edgeId}/feedback`, {
      method: 'POST',
      session: { userId: userA },
      body: { type: 'INCORRECT' },
    });
    expect(first.status).toBe(201);
    expect(((await first.json()) as { autoHidden: boolean }).autoHidden).toBe(false);

    const second = await callApi(`/api/edges/${edgeId}/feedback`, {
      method: 'POST',
      session: { userId: userB },
      body: { type: 'INCORRECT' },
    });
    expect(second.status).toBe(201);
    expect(((await second.json()) as { autoHidden: boolean }).autoHidden).toBe(true);

    const [edge] = await testDb.db
      .select({ status: edges.status })
      .from(edges)
      .where(eq(edges.id, edgeId));
    expect(edge?.status).toBe('SUPERSEDED');
  });

  it('returns 409 when the same user submits feedback twice', async () => {
    const userId = await insertTestUser(testDb.db);
    const first = await callApi(`/api/edges/${edgeId}/feedback`, {
      method: 'POST',
      session: { userId },
      body: { type: 'INCORRECT' },
    });
    expect(first.status).toBe(201);

    const second = await callApi(`/api/edges/${edgeId}/feedback`, {
      method: 'POST',
      session: { userId },
      body: { type: 'INCORRECT' },
    });
    expect(second.status).toBe(409);
  });

  it('returns 404 for a nonexistent edge', async () => {
    const userId = await insertTestUser(testDb.db);
    const response = await callApi(`/api/edges/${randomUUID()}/feedback`, {
      method: 'POST',
      session: { userId },
      body: { type: 'INCORRECT' },
    });
    expect(response.status).toBe(404);
  });

  it('returns 401 when unauthenticated', async () => {
    const response = await callApi(`/api/edges/${edgeId}/feedback`, {
      method: 'POST',
      session: null,
      body: { type: 'INCORRECT' },
    });
    expect(response.status).toBe(401);
  });

  it('leaves no Audit-13 violations after an auto-hide', async () => {
    const userA = await insertTestUser(testDb.db);
    const userB = await insertTestUser(testDb.db);
    for (const userId of [userA, userB]) {
      await callApi(`/api/edges/${edgeId}/feedback`, {
        method: 'POST',
        session: { userId },
        body: { type: 'INCORRECT' },
      });
    }

    const violations = await testDb.db.execute<{ id: string }>(sql`
      SELECT e."id"
      FROM "edges" e
      JOIN "edgeFeedback" f
        ON f."edgeId" = e."id" AND f."type" = 'INCORRECT'
      WHERE e."status" = 'SUPERSEDED'
      GROUP BY e."id"
      HAVING COUNT(DISTINCT f."userId") < 2
    `);
    expect(violations.rows).toHaveLength(0);
  });
});
