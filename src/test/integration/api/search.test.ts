import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SearchService } from '../../../lib/wikipedia/search';
import { createResolver } from '../../../lib/wikipedia/qidResolver';
import { RateLimiter } from '../../../lib/wikipedia/rateLimit';
import { createSearchService } from '../../../lib/wikipedia/search';
import { createWikidataClient } from '../../../lib/wikipedia/wikidataClient';
import { createWikipediaClient } from '../../../lib/wikipedia/wikipediaClient';
import { __resetRateLimits } from '../../../lib/http/rateLimit';
import { __setSearchServiceForTests } from '../../../lib/http/testOverrides';
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

describe('GET /api/search', () => {
  let testDb: TestDb;
  let service: SearchService;

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
    service = createSearchService({
      wikipedia,
      wikidata,
      resolver: createResolver(wikidata),
    });
  }, 60000);

  afterAll(async () => {
    __setSearchServiceForTests(null);
    __resetRateLimits();
    await closeTestDb(testDb);
  });

  beforeEach(async () => {
    await resetTestDb(testDb);
    setTestDb(testDb.db);
    __resetRateLimits();
    __setSearchServiceForTests(service);
  });

  it('returns 200 with candidates for an authenticated request', async () => {
    const userId = await insertTestUser(testDb.db);
    const response = await callApi('/api/search?q=Treaty%20of%20Versailles', {
      method: 'GET',
      session: { userId },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { candidates: unknown[] };
    expect(body.candidates.length).toBeGreaterThan(0);
  });

  it('returns 401 when unauthenticated', async () => {
    const response = await callApi('/api/search?q=test', {
      method: 'GET',
      session: null,
    });
    expect(response.status).toBe(401);
  });

  it('returns 400 when q is missing', async () => {
    const userId = await insertTestUser(testDb.db);
    const response = await callApi('/api/search', {
      method: 'GET',
      session: { userId },
    });
    expect(response.status).toBe(400);
  });

  it('returns 400 when q is longer than 200 characters', async () => {
    const userId = await insertTestUser(testDb.db);
    const response = await callApi(`/api/search?q=${'a'.repeat(201)}`, {
      method: 'GET',
      session: { userId },
    });
    expect(response.status).toBe(400);
  });

  it('returns 429 with a Retry-After header once the rate limit is exceeded', async () => {
    const userId = await insertTestUser(testDb.db);
    let last: Response | null = null;
    for (let i = 0; i < 21; i += 1) {
      last = await callApi('/api/search?q=Treaty%20of%20Versailles', {
        method: 'GET',
        session: { userId },
      });
    }
    expect(last?.status).toBe(429);
    expect(last?.headers.get('retry-after')).toBeTruthy();
  });

  it('returns 200 with an empty candidate array for a zero-result query', async () => {
    const userId = await insertTestUser(testDb.db);
    const response = await callApi(
      '/api/search?q=Fictional%20nonsense%20query%20xyzabc',
      { method: 'GET', session: { userId } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { candidates: unknown[] };
    expect(body.candidates).toEqual([]);
  });
});
