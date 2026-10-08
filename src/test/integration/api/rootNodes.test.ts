import { eq } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { __setRootNodeDepsForTests } from '../../../lib/http/testOverrides';
import { nodes } from '../../../lib/db/schema';
import { RateLimiter } from '../../../lib/wikipedia/rateLimit';
import { createSourceDocumentService } from '../../../lib/wikipedia/sourceDocuments';
import { createWikidataClient } from '../../../lib/wikipedia/wikidataClient';
import { createWikipediaClient } from '../../../lib/wikipedia/wikipediaClient';
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
import { createFixtureStore } from '../../helpers/httpFixture';

const WIKIPEDIA_DIR = fileURLToPath(
  new URL('../../fixtures/wikipedia', import.meta.url),
);
const WIKIDATA_DIR = fileURLToPath(
  new URL('../../fixtures/wikidata', import.meta.url),
);

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    pageId: 30030,
    title: 'Treaty of Versailles',
    snippet: 'The Treaty of Versailles was signed in 1919.',
    wordCount: 15234,
    resolvedQid: 'Q8736',
    qidConfidence: 'HIGH',
    ...overrides,
  };
}

describe('POST /api/root-nodes', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await getTestDb();
    const store = createFixtureStore();
    await store.loadDirectory(WIKIPEDIA_DIR);
    await store.loadDirectory(WIKIDATA_DIR);
    const fetchFn = store.buildFetch();
    const limiter = new RateLimiter({ requestsPerSecond: 1_000_000 });
    const wikipedia = createWikipediaClient({
      contactEmail: 'dev@example.com',
      fetchFn,
      rateLimiter: limiter,
    });
    const wikidata = createWikidataClient({
      contactEmail: 'dev@example.com',
      fetchFn,
      rateLimiter: limiter,
    });
    __setRootNodeDepsForTests({
      sourceDocuments: createSourceDocumentService({ db: testDb.db, wikipedia }),
      wikidata,
    });
  }, 60000);

  afterAll(async () => {
    __setRootNodeDepsForTests(null);
    await closeTestDb(testDb);
  });

  beforeEach(async () => {
    await resetTestDb(testDb);
    setTestDb(testDb.db);
  });

  it('creates a root node from a valid candidate (201)', async () => {
    const userId = await insertTestUser(testDb.db);
    const response = await callApi('/api/root-nodes', {
      method: 'POST',
      session: { userId },
      body: candidate(),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { nodeId: string; outcome: string };
    expect(body.outcome).toBe('CREATED');
    expect(body.nodeId).toBeTruthy();
  });

  it('returns 200 EXISTING for a repeat request', async () => {
    const userId = await insertTestUser(testDb.db);
    const first = await callApi('/api/root-nodes', {
      method: 'POST',
      session: { userId },
      body: candidate(),
    });
    expect(first.status).toBe(201);

    const second = await callApi('/api/root-nodes', {
      method: 'POST',
      session: { userId },
      body: candidate(),
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { outcome: string };
    expect(body.outcome).toBe('EXISTING');
  });

  it('returns 401 when unauthenticated', async () => {
    const response = await callApi('/api/root-nodes', {
      method: 'POST',
      session: null,
      body: candidate(),
    });
    expect(response.status).toBe(401);
  });

  it('returns 400 for an invalid body', async () => {
    const userId = await insertTestUser(testDb.db);
    const response = await callApi('/api/root-nodes', {
      method: 'POST',
      session: { userId },
      body: { pageId: 'not-a-number' },
    });
    expect(response.status).toBe(400);
  });

  it('falls back to the WIKIPEDIA_PAGE identity scheme when no QID is resolved', async () => {
    const userId = await insertTestUser(testDb.db);
    const response = await callApi('/api/root-nodes', {
      method: 'POST',
      session: { userId },
      body: candidate({ resolvedQid: null, qidConfidence: 'NONE' }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { nodeId: string; qid: null };
    expect(body.qid).toBeNull();

    const [row] = await testDb.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, body.nodeId));
    expect(row?.identityScheme).toBe('WIKIPEDIA_PAGE');
    expect(row?.wikipediaPageId).toBe(30030);
  });
});
