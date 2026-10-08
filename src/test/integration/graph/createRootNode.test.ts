import { eq } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { nodes, sourceDocuments as sourceDocumentRows } from '../../../lib/db/schema';import { createRootNode } from '../../../lib/graph/createRootNode';
import { RateLimiter } from '../../../lib/wikipedia/rateLimit';
import { createWikipediaClient } from '../../../lib/wikipedia/wikipediaClient';
import { createWikidataClient } from '../../../lib/wikipedia/wikidataClient';
import type { DisambiguationCandidate } from '../../../lib/wikipedia/search';
import { createSourceDocumentService } from '../../../lib/wikipedia/sourceDocuments';
import {
  closeTestDb,
  getTestDb,
  resetTestDb,
  type TestDb,
} from '../../helpers/db';
import { insertNode } from '../../helpers/fixtures';
import { createFixtureStore } from '../../helpers/httpFixture';

const WIKIPEDIA_DIR = fileURLToPath(
  new URL('../../fixtures/wikipedia', import.meta.url),
);
const WIKIDATA_DIR = fileURLToPath(
  new URL('../../fixtures/wikidata', import.meta.url),
);

function candidate(
  overrides: Partial<DisambiguationCandidate> = {},
): DisambiguationCandidate {
  return {
    pageId: 30030,
    title: 'Treaty of Versailles',
    snippet: '',
    wordCount: 0,
    resolvedQid: null,
    qidConfidence: 'NONE',
    ...overrides,
  };
}

describe('createRootNode', () => {
  let testDb: TestDb;
  let sourceDocuments: ReturnType<typeof createSourceDocumentService>;
  let wikidata: ReturnType<typeof createWikidataClient>;

  beforeAll(async () => {
    testDb = await getTestDb();
    const store = createFixtureStore();
    await store.loadDirectory(WIKIPEDIA_DIR);
    await store.loadDirectory(WIKIDATA_DIR);
    const fetchFn = store.buildFetch();
    const wikipedia = createWikipediaClient({
      contactEmail: 'dev@example.com',
      fetchFn,
      rateLimiter: new RateLimiter({ requestsPerSecond: 1_000_000 }),
    });
    wikidata = createWikidataClient({
      contactEmail: 'dev@example.com',
      fetchFn,
      rateLimiter: new RateLimiter({ requestsPerSecond: 1_000_000 }),
    });
    sourceDocuments = createSourceDocumentService({ db: testDb.db, wikipedia });
  }, 60000);

  afterAll(async () => {
    await resetTestDb(testDb);
    await closeTestDb(testDb);
  });

  beforeEach(async () => {
    await resetTestDb(testDb);
  });

  it('creates a WIKIDATA root node for a HIGH-confidence QID', async () => {
    const result = await createRootNode(testDb.db, sourceDocuments, wikidata, {
      candidate: candidate({ resolvedQid: 'Q8736', qidConfidence: 'HIGH' }),
    });

    expect(result.outcome).toBe('CREATED');
    expect(result.qid).toBe('Q8736');

    const [row] = await testDb.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, result.nodeId));
    expect(row?.identityScheme).toBe('WIKIDATA');
    expect(row?.wikidataQid).toBe('Q8736');
    expect(row?.isRoot).toBe(true);
  });

  it('creates a WIKIPEDIA_PAGE root node when no QID is resolved', async () => {
    const result = await createRootNode(testDb.db, sourceDocuments, wikidata, {
      candidate: candidate(),
    });

    expect(result.qid).toBeNull();
    const [row] = await testDb.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, result.nodeId));
    expect(row?.identityScheme).toBe('WIKIPEDIA_PAGE');
    expect(row?.wikipediaPageId).toBe(30030);
    expect(row?.isRoot).toBe(true);
  });

  it('returns EXISTING for a QID that already exists as a root', async () => {
    await insertNode(testDb.db, {
      identityScheme: 'WIKIDATA',
      wikidataQid: 'Q8736',
      label: 'Existing root',
      nodeType: 'POLICY',
      isRoot: true,
    });

    const result = await createRootNode(testDb.db, sourceDocuments, wikidata, {
      candidate: candidate({ resolvedQid: 'Q8736', qidConfidence: 'HIGH' }),
    });
    expect(result.outcome).toBe('EXISTING');

    const [row] = await testDb.db
      .select()
      .from(nodes)
      .where(eq(nodes.wikidataQid, 'Q8736'));
    expect(row?.isRoot).toBe(true);
  });

  it('promotes an existing non-root node to root', async () => {
    const existingId = await insertNode(testDb.db, {
      identityScheme: 'WIKIDATA',
      wikidataQid: 'Q8736',
      label: 'Discovered via expansion',
      nodeType: 'POLICY',
      isRoot: false,
    });

    const result = await createRootNode(testDb.db, sourceDocuments, wikidata, {
      candidate: candidate({ resolvedQid: 'Q8736', qidConfidence: 'HIGH' }),
    });
    expect(result.outcome).toBe('EXISTING');
    expect(result.nodeId).toBe(existingId);

    const [row] = await testDb.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, existingId));
    expect(row?.isRoot).toBe(true);
  });

  it('creates and links a SourceDocument', async () => {
    const result = await createRootNode(testDb.db, sourceDocuments, wikidata, {
      candidate: candidate({ resolvedQid: 'Q8736', qidConfidence: 'HIGH' }),
    });
    const [document] = await testDb.db
      .select()
      .from(sourceDocumentRows)
      .where(eq(sourceDocumentRows.id, result.sourceDocumentId));
    expect(document).toBeDefined();
    expect(document?.wikipediaPageId).toBe(30030);
    expect(document?.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('infers the node type from Wikidata (POLICY for a peace treaty)', async () => {
    const result = await createRootNode(testDb.db, sourceDocuments, wikidata, {
      candidate: candidate({ resolvedQid: 'Q8736', qidConfidence: 'HIGH' }),
    });
    const [row] = await testDb.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, result.nodeId));
    expect(row?.nodeType).toBe('POLICY');
  });

  it('extracts start and end dates from Wikidata range claims', async () => {
    const result = await createRootNode(testDb.db, sourceDocuments, wikidata, {
      candidate: candidate({
        pageId: 14914,
        title: 'Industrial Revolution',
        resolvedQid: 'Q2269',
        qidConfidence: 'HIGH',
      }),
    });
    const [row] = await testDb.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, result.nodeId));
    expect(row?.dateStartYear).toBe(1760);
    expect(row?.dateStartPrecision).toBe('YEAR');
    expect(row?.dateEndYear).toBe(1820);
    expect(row?.dateEndPrecision).toBe('YEAR');
  });

  it('represents a BCE date as a negative year', async () => {
    const result = await createRootNode(testDb.db, sourceDocuments, wikidata, {
      candidate: candidate({
        pageId: 5008,
        title: 'Battle of Actium',
        resolvedQid: 'Q160387',
        qidConfidence: 'HIGH',
      }),
    });
    const [row] = await testDb.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, result.nodeId));
    expect(row?.dateStartYear).toBe(-31);
    expect(row?.dateStartMonth).toBe(9);
    expect(row?.dateStartDay).toBe(2);
    expect(row?.dateStartPrecision).toBe('DAY');
  });

  it('falls back to the Wikipedia page for a LOW-confidence QID', async () => {
    const result = await createRootNode(testDb.db, sourceDocuments, wikidata, {
      candidate: candidate({ resolvedQid: 'Q8736', qidConfidence: 'LOW' }),
    });
    expect(result.qid).toBeNull();
    const [row] = await testDb.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, result.nodeId));
    expect(row?.identityScheme).toBe('WIKIPEDIA_PAGE');
  });
});
