import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { createTestFixtures, type TestFixtures } from '../../helpers/fixtures';
import {
  insertVerifiedEdgeThroughApp,
  makeEvidence,
} from '../../helpers/edgeHelper';

describe('GET /api/nodes', () => {
  let testDb: TestDb;
  let fixtures: TestFixtures;

  beforeAll(async () => {
    testDb = await getTestDb();
  }, 60000);

  afterAll(async () => {
    await closeTestDb(testDb);
  });

  beforeEach(async () => {
    await resetTestDb(testDb);
    setTestDb(testDb.db);
    fixtures = await createTestFixtures(testDb.db);
    const evidence = (overrides: { quoteText?: string } = {}) =>
      makeEvidence(
        {
          sourceDocumentId: fixtures.sourceDocumentId,
          extractionRunId: fixtures.extractionRunId,
        },
        overrides,
      );
    // A -> B -> C (A earliest).
    await insertVerifiedEdgeThroughApp(testDb.db, {
      causeNodeId: fixtures.nodeA,
      effectNodeId: fixtures.nodeB,
      relationType: 'CAUSED',
      importanceRank: 1,
      contested: false,
      extractionRunId: fixtures.extractionRunId,
      evidence: [evidence()],
    });
    await insertVerifiedEdgeThroughApp(testDb.db, {
      causeNodeId: fixtures.nodeB,
      effectNodeId: fixtures.nodeC,
      relationType: 'CAUSED',
      importanceRank: 1,
      contested: false,
      extractionRunId: fixtures.extractionRunId,
      evidence: [evidence()],
    });
  });

  it('returns the node with its neighborhood', async () => {
    const userId = await insertTestUser(testDb.db);
    const response = await callApi(`/api/nodes/${fixtures.nodeB}`, {
      method: 'GET',
      session: { userId },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      node: { id: string; isRoot: boolean };
      causes: unknown[];
      effects: unknown[];
    };
    expect(body.node.id).toBe(fixtures.nodeB);
    expect(body.node.isRoot).toBe(false);
    expect(body.causes).toHaveLength(1);
    expect(body.effects).toHaveLength(1);
  });

  it('returns 404 for a nonexistent node', async () => {
    const userId = await insertTestUser(testDb.db);
    const response = await callApi(`/api/nodes/${randomUUID()}`, {
      method: 'GET',
      session: { userId },
    });
    expect(response.status).toBe(404);
  });

  it('returns 400 for an invalid UUID', async () => {
    const userId = await insertTestUser(testDb.db);
    const response = await callApi('/api/nodes/not-a-uuid', {
      method: 'GET',
      session: { userId },
    });
    expect(response.status).toBe(400);
  });

  it('returns 401 when unauthenticated', async () => {
    const response = await callApi(`/api/nodes/${fixtures.nodeB}`, {
      method: 'GET',
      session: null,
    });
    expect(response.status).toBe(401);
  });

  it('returns bounded ancestors', async () => {
    const userId = await insertTestUser(testDb.db);
    const response = await callApi(
      `/api/nodes/${fixtures.nodeC}/ancestors?depth=2`,
      { method: 'GET', session: { userId } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      nodes: Array<{ id: string }>;
      edges: unknown[];
    };
    expect(body.nodes.map((n) => n.id).sort()).toEqual(
      [fixtures.nodeA, fixtures.nodeB].sort(),
    );
    expect(body.edges).toHaveLength(2);
  });

  it('returns 400 for a descendants depth greater than 4', async () => {
    const userId = await insertTestUser(testDb.db);
    const response = await callApi(
      `/api/nodes/${fixtures.nodeA}/descendants?depth=5`,
      { method: 'GET', session: { userId } },
    );
    expect(response.status).toBe(400);
  });
});
