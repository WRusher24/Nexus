import { eq } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sourceDocuments } from '../../../lib/db/schema';
import { sha256 } from '../../../lib/wikipedia/parser';
import { RateLimiter } from '../../../lib/wikipedia/rateLimit';
import { createWikipediaClient } from '../../../lib/wikipedia/wikipediaClient';
import { createSourceDocumentService } from '../../../lib/wikipedia/sourceDocuments';
import {
  closeTestDb,
  getTestDb,
  resetTestDb,
  type TestDb,
} from '../../helpers/db';
import { insertSourceDocument } from '../../helpers/fixtures';
import { createFixtureStore } from '../../helpers/httpFixture';

const PAGE_ID = 30030;
const WIKIPEDIA_DIR = fileURLToPath(
  new URL('../../fixtures/wikipedia', import.meta.url),
);
const WIKIDATA_DIR = fileURLToPath(
  new URL('../../fixtures/wikidata', import.meta.url),
);

describe('SourceDocumentService', () => {
  let testDb: TestDb;
  let service: ReturnType<typeof createSourceDocumentService>;

  beforeAll(async () => {
    testDb = await getTestDb();
    const store = createFixtureStore();
    await store.loadDirectory(WIKIPEDIA_DIR);
    await store.loadDirectory(WIKIDATA_DIR);
    const wikipedia = createWikipediaClient({
      contactEmail: 'dev@example.com',
      fetchFn: store.buildFetch(),
      rateLimiter: new RateLimiter({ requestsPerSecond: 1_000_000 }),
    });
    service = createSourceDocumentService({ db: testDb.db, wikipedia });
  }, 60000);

  afterAll(async () => {
    await resetTestDb(testDb);
    await closeTestDb(testDb);
  });

  beforeEach(async () => {
    await resetTestDb(testDb);
  });

  it('creates a new SourceDocument row on an empty database', async () => {
    const document = await service.fetchAndStore(PAGE_ID);
    expect(document.wikipediaPageId).toBe(PAGE_ID);
    expect(document.wikipediaTitle).toBe('Treaty of Versailles');
    expect(document.rawText.length).toBeGreaterThan(1000);
    expect(document.sectionIndex.length).toBeGreaterThan(1);

    const rows = await testDb.db.select().from(sourceDocuments);
    expect(rows).toHaveLength(1);
  });

  it('returns the existing row for the same (page, revision) without duplicating', async () => {
    const first = await service.fetchAndStore(PAGE_ID);
    const second = await service.fetchAndStore(PAGE_ID);
    expect(second.id).toBe(first.id);

    const rows = await testDb.db
      .select()
      .from(sourceDocuments)
      .where(eq(sourceDocuments.wikipediaPageId, PAGE_ID));
    expect(rows).toHaveLength(1);
  });

  it('allows two revisions of the same page to coexist', async () => {
    await insertSourceDocument(testDb.db, {
      wikipediaPageId: PAGE_ID,
      wikipediaTitle: 'Treaty of Versailles',
      revisionId: 111111,
    });

    const fetched = await service.fetchAndStore(PAGE_ID);
    expect(fetched.revisionId).not.toBe(111111);

    const rows = await testDb.db
      .select()
      .from(sourceDocuments)
      .where(eq(sourceDocuments.wikipediaPageId, PAGE_ID));
    expect(rows).toHaveLength(2);
  });

  it('looks up a specific revision', async () => {
    const inserted = await insertSourceDocument(testDb.db, {
      wikipediaPageId: PAGE_ID,
      revisionId: 424242,
    });
    const found = await service.getByRevision(PAGE_ID, 424242);
    expect(found?.id).toBe(inserted.id);
    await expect(service.getByRevision(PAGE_ID, 999999)).resolves.toBeNull();
  });

  it('returns the most recent document by fetchedAt', async () => {
    await insertSourceDocument(testDb.db, {
      wikipediaPageId: PAGE_ID,
      revisionId: 111,
      fetchedAt: new Date('2020-01-01T00:00:00Z'),
    });
    await insertSourceDocument(testDb.db, {
      wikipediaPageId: PAGE_ID,
      revisionId: 222,
      fetchedAt: new Date('2025-01-01T00:00:00Z'),
    });

    const latest = await service.getLatest(PAGE_ID);
    expect(latest?.revisionId).toBe(222);
  });

  it('computes and stores the SHA-256 content hash', async () => {
    const document = await service.fetchAndStore(PAGE_ID);
    expect(document.contentHash).toBe(sha256(document.rawText));
  });
});
