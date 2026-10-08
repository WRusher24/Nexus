import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expansionRequests } from '../../lib/db/schema';
import {
  captureError,
  closeTestDb,
  getPgErrorCode,
  getTestDb,
  resetTestDb,
  type TestDb,
} from '../helpers/db';
import { createTestFixtures, type TestFixtures } from '../helpers/fixtures';

const UNIQUE_VIOLATION = '23505';

describe('Expansion request in-flight constraints', () => {
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

  it('rejects a second PENDING request for the same (node, direction)', async () => {
    await testDb.db.insert(expansionRequests).values({
      nodeId: fixtures.nodeA,
      direction: 'UPSTREAM',
      requestedBy: 'user-1',
    });

    const error = await captureError(() =>
      testDb.db.insert(expansionRequests).values({
        nodeId: fixtures.nodeA,
        direction: 'UPSTREAM',
        requestedBy: 'user-2',
      }),
    );

    expect(getPgErrorCode(error)).toBe(UNIQUE_VIOLATION);
    const rows = await testDb.db.select().from(expansionRequests);
    expect(rows).toHaveLength(1);
  });

  it('allows one PENDING and one COMPLETED request for the same (node, direction)', async () => {
    await testDb.db.insert(expansionRequests).values({
      nodeId: fixtures.nodeA,
      direction: 'UPSTREAM',
      requestedBy: 'user-1',
      status: 'PENDING',
    });
    await testDb.db.insert(expansionRequests).values({
      nodeId: fixtures.nodeA,
      direction: 'UPSTREAM',
      requestedBy: 'user-1',
      status: 'COMPLETED',
    });

    const rows = await testDb.db
      .select()
      .from(expansionRequests)
      .where(eq(expansionRequests.nodeId, fixtures.nodeA));
    expect(rows).toHaveLength(2);
  });

  it('allows a PENDING UPSTREAM and a PENDING DOWNSTREAM request for the same node', async () => {
    await testDb.db.insert(expansionRequests).values({
      nodeId: fixtures.nodeA,
      direction: 'UPSTREAM',
      requestedBy: 'user-1',
    });
    await testDb.db.insert(expansionRequests).values({
      nodeId: fixtures.nodeA,
      direction: 'DOWNSTREAM',
      requestedBy: 'user-1',
    });

    const rows = await testDb.db
      .select()
      .from(expansionRequests)
      .where(eq(expansionRequests.nodeId, fixtures.nodeA));
    expect(rows).toHaveLength(2);
  });
});
