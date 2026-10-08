import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { nodes } from '../../lib/db/schema';
import {
  captureError,
  closeTestDb,
  getPgErrorCode,
  getTestDatabaseUrl,
  getTestDb,
  resetTestDb,
  type TestDb,
} from '../helpers/db';
import { insertNode } from '../helpers/fixtures';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

describe('P1: canonical identity', () => {
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

  it('inserts a node with a QID', async () => {
    const id = await insertNode(testDb.db, {
      identityScheme: 'WIKIDATA',
      wikidataQid: 'Q361',
      label: 'Treaty of Versailles',
      nodeType: 'POLICY',
    });

    const [row] = await testDb.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, id));
    expect(row?.wikidataQid).toBe('Q361');
  });

  it('inserts a node with only a wikipediaPageId', async () => {
    const id = await insertNode(testDb.db, {
      identityScheme: 'WIKIPEDIA_PAGE',
      wikipediaPageId: 123456,
      label: 'Obscure battle',
      nodeType: 'EVENT',
    });

    const [row] = await testDb.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, id));
    expect(row?.identityScheme).toBe('WIKIPEDIA_PAGE');
    expect(row?.wikidataQid).toBeNull();
    expect(row?.nexusGeneratedId).toBeNull();
  });

  it('inserts a node with only a nexusGeneratedId', async () => {
    const id = await insertNode(testDb.db, {
      identityScheme: 'NEXUS_GENERATED',
      nexusGeneratedId: 'nexus:generated:abc123',
      label: 'Synthesised entity',
      nodeType: 'PROCESS',
    });

    const [row] = await testDb.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, id));
    expect(row?.identityScheme).toBe('NEXUS_GENERATED');
    expect(row?.wikidataQid).toBeNull();
    expect(row?.wikipediaPageId).toBeNull();
  });

  it('rejects a node with no identity fields (chk_node_identity)', async () => {
    const error = await captureError(() =>
      insertNode(testDb.db, {
        identityScheme: 'WIKIDATA',
        wikidataQid: null,
        wikipediaPageId: null,
        nexusGeneratedId: null,
      }),
    );

    expect(getPgErrorCode(error)).toBe(CHECK_VIOLATION);
    const rows = await testDb.db.select().from(nodes);
    expect(rows).toHaveLength(0);
  });

  it('rejects a second node with the same wikidataQid', async () => {
    await insertNode(testDb.db, {
      identityScheme: 'WIKIDATA',
      wikidataQid: 'Q100',
    });

    const error = await captureError(() =>
      insertNode(testDb.db, {
        identityScheme: 'WIKIDATA',
        wikidataQid: 'Q100',
        label: 'Duplicate',
      }),
    );

    expect(getPgErrorCode(error)).toBe(UNIQUE_VIOLATION);
    const rows = await testDb.db.select().from(nodes);
    expect(rows).toHaveLength(1);
  });

  it('rejects a second node with the same nexusGeneratedId', async () => {
    await insertNode(testDb.db, {
      identityScheme: 'NEXUS_GENERATED',
      nexusGeneratedId: 'nexus:generated:dup',
    });

    const error = await captureError(() =>
      insertNode(testDb.db, {
        identityScheme: 'NEXUS_GENERATED',
        nexusGeneratedId: 'nexus:generated:dup',
        label: 'Duplicate',
      }),
    );

    expect(getPgErrorCode(error)).toBe(UNIQUE_VIOLATION);
    const rows = await testDb.db.select().from(nodes);
    expect(rows).toHaveLength(1);
  });

  it('allows two nodes to share a wikipediaPageId when QIDs differ', async () => {
    // wikipediaPageId is intentionally NOT unique: Wikipedia redirects mean a
    // page id can surface for more than one resolved entity. QID is the
    // canonical key; page id is only a fallback identity.
    await insertNode(testDb.db, {
      identityScheme: 'WIKIDATA',
      wikidataQid: 'Q200',
      wikipediaPageId: 555,
      label: 'First',
    });
    await insertNode(testDb.db, {
      identityScheme: 'WIKIDATA',
      wikidataQid: 'Q201',
      wikipediaPageId: 555,
      label: 'Second',
    });

    const rows = await testDb.db
      .select()
      .from(nodes)
      .where(eq(nodes.wikipediaPageId, 555));
    expect(rows).toHaveLength(2);
  });

  it('cannot create duplicate nodes for the same QID under concurrency', async () => {
    const url = getTestDatabaseUrl();
    const pool1 = new Pool({ connectionString: url, max: 1 });
    const pool2 = new Pool({ connectionString: url, max: 1 });
    const db1 = drizzle(pool1);
    const db2 = drizzle(pool2);

    try {
      const attempt = (db: ReturnType<typeof drizzle>, label: string) =>
        db.insert(nodes).values({
          identityScheme: 'WIKIDATA',
          wikidataQid: 'Q999',
          label,
          nodeType: 'EVENT',
        });

      const results = await Promise.allSettled([
        attempt(db1, 'Racer one'),
        attempt(db2, 'Racer two'),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      if (rejected[0]?.status === 'rejected') {
        expect(getPgErrorCode(rejected[0].reason)).toBe(UNIQUE_VIOLATION);
      }

      const rows = await testDb.db
        .select()
        .from(nodes)
        .where(eq(nodes.wikidataQid, 'Q999'));
      expect(rows).toHaveLength(1);
    } finally {
      await pool1.end();
      await pool2.end();
    }
  });
});
