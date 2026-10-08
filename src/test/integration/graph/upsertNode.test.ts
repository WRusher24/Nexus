import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../../lib/db/schema';
import { nodes } from '../../../lib/db/schema';
import { upsertNode } from '../../../lib/graph/upsertNode';
import type { UpsertNodeInput } from '../../../lib/graph/types';
import {
  closeTestDb,
  getTestDatabaseUrl,
  getTestDb,
  resetTestDb,
  type TestDb,
} from '../../helpers/db';
import { insertNode, uniqueQid } from '../../helpers/fixtures';

describe('upsertNode (P1 canonical identity)', () => {
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

  const baseInput = (overrides: Partial<UpsertNodeInput> = {}): UpsertNodeInput => ({
    identity: { wikidataQid: uniqueQid() },
    label: 'A test event',
    nodeType: 'EVENT',
    ...overrides,
  });

  it('creates a node with a QID using the WIKIDATA identity scheme', async () => {
    const input = baseInput();
    const result = await upsertNode(testDb.db, input);

    expect(result.outcome).toBe('CREATED');
    if (result.outcome !== 'CREATED') return;

    const [row] = await testDb.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, result.nodeId));
    expect(row?.identityScheme).toBe('WIKIDATA');
    expect(row?.wikidataQid).toBe(input.identity.wikidataQid);
  });

  it('returns EXISTING with the same nodeId for a repeated QID', async () => {
    const input = baseInput();
    const first = await upsertNode(testDb.db, input);
    const second = await upsertNode(testDb.db, input);

    expect(first.outcome).toBe('CREATED');
    expect(second.outcome).toBe('EXISTING');
    if (first.outcome !== 'CREATED' || second.outcome !== 'EXISTING') return;
    expect(second.nodeId).toBe(first.nodeId);
    expect(second.updated).toBe(false);
  });

  it('creates a node from wikipediaPageId only using WIKIPEDIA_PAGE', async () => {
    const pageId = 424242;
    const result = await upsertNode(testDb.db, {
      identity: { wikipediaPageId: pageId },
      label: 'Page node',
      nodeType: 'PLACE',
    });

    expect(result.outcome).toBe('CREATED');
    if (result.outcome !== 'CREATED') return;

    const [row] = await testDb.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, result.nodeId));
    expect(row?.identityScheme).toBe('WIKIPEDIA_PAGE');
    expect(row?.wikipediaPageId).toBe(pageId);
  });

  it('creates a node from nexusGeneratedId only using NEXUS_GENERATED', async () => {
    const generatedId = `gen-${uniqueQid()}`;
    const result = await upsertNode(testDb.db, {
      identity: { nexusGeneratedId: generatedId },
      label: 'Generated node',
      nodeType: 'IDEOLOGY',
    });

    expect(result.outcome).toBe('CREATED');
    if (result.outcome !== 'CREATED') return;

    const [row] = await testDb.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, result.nodeId));
    expect(row?.identityScheme).toBe('NEXUS_GENERATED');
    expect(row?.nexusGeneratedId).toBe(generatedId);
  });

  it('throws a P1 violation when no identity is provided', async () => {
    await expect(
      upsertNode(testDb.db, {
        identity: {},
        label: 'No identity',
        nodeType: 'EVENT',
      }),
    ).rejects.toThrow(/P1 VIOLATION/);
  });

  it('rejects a QID that does not match ^Q\\d+$', async () => {
    await expect(
      upsertNode(testDb.db, {
        identity: { wikidataQid: 'X123' },
        label: 'Bad QID',
        nodeType: 'EVENT',
      }),
    ).rejects.toThrow(/wikidataQid/);
  });

  it('does not overwrite an existing non-empty label', async () => {
    const qid = uniqueQid();
    await insertNode(testDb.db, {
      identityScheme: 'WIKIDATA',
      wikidataQid: qid,
      label: 'Original label',
      nodeType: 'EVENT',
    });

    const result = await upsertNode(testDb.db, {
      identity: { wikidataQid: qid },
      label: 'Replacement label',
      nodeType: 'EVENT',
    });

    expect(result.outcome).toBe('EXISTING');
    if (result.outcome !== 'EXISTING') return;
    expect(result.updated).toBe(false);

    const [row] = await testDb.db
      .select()
      .from(nodes)
      .where(eq(nodes.wikidataQid, qid));
    expect(row?.label).toBe('Original label');
  });

  it('fills a missing brief on an existing node', async () => {
    const qid = uniqueQid();
    await insertNode(testDb.db, {
      identityScheme: 'WIKIDATA',
      wikidataQid: qid,
      label: 'Existing',
      nodeType: 'EVENT',
      brief: null,
    });

    const result = await upsertNode(testDb.db, {
      identity: { wikidataQid: qid },
      label: 'Existing',
      nodeType: 'EVENT',
      brief: 'A newly extracted brief.',
    });

    expect(result.outcome).toBe('EXISTING');
    if (result.outcome !== 'EXISTING') return;
    expect(result.updated).toBe(true);

    const [row] = await testDb.db
      .select()
      .from(nodes)
      .where(eq(nodes.wikidataQid, qid));
    expect(row?.brief).toBe('A newly extracted brief.');
  });

  it('upgrades an UNKNOWN date to YEAR precision', async () => {
    const qid = uniqueQid();
    await insertNode(testDb.db, {
      identityScheme: 'WIKIDATA',
      wikidataQid: qid,
      label: 'Undated',
      nodeType: 'EVENT',
      dateStartPrecision: 'UNKNOWN',
    });

    const result = await upsertNode(testDb.db, {
      identity: { wikidataQid: qid },
      label: 'Undated',
      nodeType: 'EVENT',
      dateStartYear: 1914,
      dateStartPrecision: 'YEAR',
    });

    expect(result.outcome).toBe('EXISTING');
    if (result.outcome !== 'EXISTING') return;
    expect(result.updated).toBe(true);

    const [row] = await testDb.db
      .select()
      .from(nodes)
      .where(eq(nodes.wikidataQid, qid));
    expect(row?.dateStartYear).toBe(1914);
    expect(row?.dateStartPrecision).toBe('YEAR');
  });

  it('does not downgrade a YEAR date to DECADE precision', async () => {
    const qid = uniqueQid();
    await insertNode(testDb.db, {
      identityScheme: 'WIKIDATA',
      wikidataQid: qid,
      label: 'Dated',
      nodeType: 'EVENT',
      dateStartYear: 1850,
      dateStartPrecision: 'YEAR',
    });

    const result = await upsertNode(testDb.db, {
      identity: { wikidataQid: qid },
      label: 'Dated',
      nodeType: 'EVENT',
      dateStartYear: 1840,
      dateStartPrecision: 'DECADE',
    });

    expect(result.outcome).toBe('EXISTING');
    const [row] = await testDb.db
      .select()
      .from(nodes)
      .where(eq(nodes.wikidataQid, qid));
    expect(row?.dateStartYear).toBe(1850);
    expect(row?.dateStartPrecision).toBe('YEAR');
  });

  it('concurrent upserts of the same QID yield one row and one CREATED', async () => {
    const qid = uniqueQid();
    const pool2 = new Pool({ connectionString: getTestDatabaseUrl(), max: 5 });
    const db2 = drizzle(pool2, { schema });
    try {
      const input: UpsertNodeInput = {
        identity: { wikidataQid: qid },
        label: 'Concurrent',
        nodeType: 'EVENT',
      };

      const [r1, r2] = await Promise.all([
        upsertNode(testDb.db, input),
        upsertNode(db2, input),
      ]);

      const outcomes = [r1.outcome, r2.outcome].sort();
      expect(outcomes).toEqual(['CREATED', 'EXISTING']);

      const rows = await testDb.db
        .select()
        .from(nodes)
        .where(eq(nodes.wikidataQid, qid));
      expect(rows).toHaveLength(1);
    } finally {
      await pool2.end();
    }
  });

  it('rejects DAY precision without a day before touching the database', async () => {
    await expect(
      upsertNode(testDb.db, {
        identity: { wikidataQid: uniqueQid() },
        label: 'Bad date',
        nodeType: 'EVENT',
        dateStartYear: 1900,
        dateStartMonth: 1,
        dateStartDay: null,
        dateStartPrecision: 'DAY',
      }),
    ).rejects.toThrow(/precision DAY/);
  });

  it('rejects an unknown nodeType', async () => {
    await expect(
      upsertNode(testDb.db, {
        identity: { wikidataQid: uniqueQid() },
        label: 'Bad type',
        // Deliberately bypass the compile-time union to prove runtime guard.
        nodeType: 'NOT_A_TYPE' as UpsertNodeInput['nodeType'],
      }),
    ).rejects.toThrow(/Invalid nodeType/);
  });
});
