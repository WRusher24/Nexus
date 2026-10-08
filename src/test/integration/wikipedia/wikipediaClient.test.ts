import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../../../lib/wikipedia/rateLimit';
import {
  buildSearchUrl,
  createWikipediaClient,
  WIKIPEDIA_API_HOST,
  WikipediaError,
  type WikipediaClient,
} from '../../../lib/wikipedia/wikipediaClient';
import {
  createFixtureStore,
  type FixtureStore,
} from '../../helpers/httpFixture';

const CONTACT_EMAIL = 'dev@example.com';
const API_BASE = `${WIKIPEDIA_API_HOST}/w/api.php`;
const WIKIPEDIA_DIR = fileURLToPath(
  new URL('../../fixtures/wikipedia', import.meta.url),
);
const WIKIDATA_DIR = fileURLToPath(
  new URL('../../fixtures/wikidata', import.meta.url),
);

function fastLimiter(): RateLimiter {
  return new RateLimiter({ requestsPerSecond: 1_000_000 });
}

function makeClient(store: FixtureStore, overrides: Partial<Parameters<typeof createWikipediaClient>[0]> = {}): WikipediaClient {
  return createWikipediaClient({
    contactEmail: CONTACT_EMAIL,
    fetchFn: store.buildFetch(),
    rateLimiter: fastLimiter(),
    sleep: () => Promise.resolve(),
    ...overrides,
  });
}

describe('WikipediaClient', () => {
  let store: FixtureStore;
  let client: WikipediaClient;

  beforeAll(async () => {
    store = createFixtureStore();
    await store.loadDirectory(WIKIPEDIA_DIR);
    await store.loadDirectory(WIKIDATA_DIR);
    client = makeClient(store);
  });

  it('throws at construction when contactEmail is missing', () => {
    expect(() =>
      createWikipediaClient({ contactEmail: '' }),
    ).toThrow(/contactEmail/);
  });

  it('searches and returns up to five well-shaped candidates', async () => {
    const results = await client.search('Treaty of Versailles');
    expect(results).toHaveLength(5);
    const first = results[0];
    expect(first?.pageId).toBe(30030);
    expect(first?.title).toBe('Treaty of Versailles');
    expect(first?.snippet).toContain('searchmatch');
    expect(typeof first?.wordCount).toBe('number');
  });

  it('returns an empty array for an empty query without making a request', async () => {
    const before = store.getHits().length;
    await expect(client.search('   ')).resolves.toEqual([]);
    expect(store.getHits().length).toBe(before);
  });

  it('returns an empty array when search has no results', async () => {
    const results = await client.search('Fictional nonsense query xyzabc');
    expect(results).toEqual([]);
  });

  it('fetches an article by page id with text, sections and revision id', async () => {
    const article = await client.fetchArticleByPageId(30030);
    expect(article.pageId).toBe(30030);
    expect(article.title).toBe('Treaty of Versailles');
    expect(article.plainText.length).toBeGreaterThan(1000);
    expect(article.sections.length).toBeGreaterThan(1);
    expect(article.sections[0]?.title).toBe('');
    expect(typeof article.revisionId).toBe('number');
    expect(article.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fetches an article by title following redirects', async () => {
    const article = await client.fetchArticleByTitle('Treaty of Versailles');
    expect(article?.pageId).toBe(30030);
    expect(article?.plainText.length).toBeGreaterThan(0);
  });

  it('returns null for a disambiguation page title', async () => {
    await expect(client.fetchArticleByTitle('Mercury')).resolves.toBeNull();
  });

  it('fetches an article pinned to a specific revision id', async () => {
    const article = await client.fetchArticleByRevisionId(1366357557);
    expect(article.title).toBe('Treaty of Versailles (1768)');
    expect(article.plainText).toContain('Genoa sold Corsica to France');
  });

  it('acquires a rate limiter token before each request', async () => {
    const limiter = fastLimiter();
    const spy = vi.spyOn(limiter, 'acquire');
    const scoped = makeClient(store, { rateLimiter: limiter });
    await scoped.search('Treaty of Versailles');
    expect(spy).toHaveBeenCalled();
  });

  it('sends the User-Agent header on every request', async () => {
    const base = store.buildFetch();
    const headers: Array<Record<string, string>> = [];
    const spyFetch: typeof fetch = async (input, init) => {
      if (init?.headers && typeof init.headers === 'object') {
        headers.push(init.headers as Record<string, string>);
      }
      return base(input, init);
    };
    const scoped = makeClient(store, { fetchFn: spyFetch });
    await scoped.fetchArticleByPageId(30030);
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) {
      expect(header['User-Agent']).toBe(
        `Nexus/1.0 (${CONTACT_EMAIL}) nexus-history-graph`,
      );
    }
  });

  it('throws PAGE_NOT_FOUND on a 404 response', async () => {
    const url = buildSearchUrl(API_BASE, 'trigger-404', 5);
    store.register({ url, method: 'GET', status: 404, body: { error: 'nope' } });
    const error = await client.search('trigger-404').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WikipediaError);
    expect((error as WikipediaError).code).toBe('PAGE_NOT_FOUND');
  });

  it('retries a 500 response and then throws SERVER_ERROR', async () => {
    const url = buildSearchUrl(API_BASE, 'trigger-500', 5);
    store.register({ url, method: 'GET', status: 500, body: { error: 'boom' } });

    let calls = 0;
    const countingFetch: typeof fetch = async (input, init) => {
      calls += 1;
      return store.buildFetch()(input, init);
    };
    const scoped = makeClient(store, { fetchFn: countingFetch });

    const error = await scoped.search('trigger-500').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WikipediaError);
    expect((error as WikipediaError).code).toBe('SERVER_ERROR');
    expect(calls).toBe(4); // initial attempt + 3 retries
  });
});
