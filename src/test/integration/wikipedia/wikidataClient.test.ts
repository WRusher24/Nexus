import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../../../lib/wikipedia/rateLimit';
import {
  createWikidataClient,
  parseWikidataTime,
  parseWikidataYear,
  type WikidataClient,
} from '../../../lib/wikipedia/wikidataClient';
import {
  createFixtureStore,
  type FixtureStore,
} from '../../helpers/httpFixture';

const CONTACT_EMAIL = 'dev@example.com';
const WIKIPEDIA_DIR = fileURLToPath(
  new URL('../../fixtures/wikipedia', import.meta.url),
);
const WIKIDATA_DIR = fileURLToPath(
  new URL('../../fixtures/wikidata', import.meta.url),
);

function fastLimiter(): RateLimiter {
  return new RateLimiter({ requestsPerSecond: 1_000_000 });
}

describe('WikidataClient', () => {
  let store: FixtureStore;
  let client: WikidataClient;

  beforeAll(async () => {
    store = createFixtureStore();
    await store.loadDirectory(WIKIPEDIA_DIR);
    await store.loadDirectory(WIKIDATA_DIR);
    client = createWikidataClient({
      contactEmail: CONTACT_EMAIL,
      fetchFn: store.buildFetch(),
      rateLimiter: fastLimiter(),
      sleep: () => Promise.resolve(),
    });
  });

  it('searches Wikidata and returns candidates with QIDs', async () => {
    const results = await client.search('Treaty of Versailles');
    expect(results.length).toBeGreaterThan(0);
    const first = results[0];
    expect(first?.qid).toMatch(/^Q\d+$/);
    expect(first?.label).toBe('Treaty of Versailles');
    expect(first?.match.type).toBe('label');
  });

  it('fetches an entity with claims, aliases and sitelinks', async () => {
    const entity = await client.getEntity('Q8736');
    expect(entity.qid).toBe('Q8736');
    expect(entity.label).toBe('Treaty of Versailles');
    expect(entity.aliases.length).toBeGreaterThan(0);
    expect(entity.wikipediaTitle).toBe('Treaty of Versailles');
    expect(entity.instanceOf).toContain('Q625298');
  });

  it('parses start and end time claims for World War I', async () => {
    const entity = await client.getEntity('Q361');
    expect(entity.claims.P580?.[0]?.time.startsWith('+1914')).toBe(true);
    expect(entity.claims.P582?.[0]?.time.startsWith('+1918')).toBe(true);
  });

  it('resolves a QID from an English Wikipedia title', async () => {
    await expect(
      client.getQidForWikipediaTitle('Treaty of Versailles'),
    ).resolves.toBe('Q8736');
  });

  it('returns null for a Wikipedia title with no Wikidata item', async () => {
    await expect(
      client.getQidForWikipediaTitle('Nonexistent Fictional Page xyz'),
    ).resolves.toBeNull();
  });

  it('follows a merged-QID redirect to the target', async () => {
    await expect(client.resolveRedirect('Q840')).resolves.toBe('Q46');
  });

  it('calls the rate limiter before each request', async () => {
    const limiter = fastLimiter();
    const spy = vi.spyOn(limiter, 'acquire');
    const scoped = createWikidataClient({
      contactEmail: CONTACT_EMAIL,
      fetchFn: store.buildFetch(),
      rateLimiter: limiter,
    });
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
    const scoped = createWikidataClient({
      contactEmail: CONTACT_EMAIL,
      fetchFn: spyFetch,
      rateLimiter: fastLimiter(),
    });
    await scoped.search('Treaty of Versailles');
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) {
      expect(header['User-Agent']).toBe(
        `Nexus/1.0 (${CONTACT_EMAIL}) nexus-history-graph`,
      );
    }
  });

  it('parses BCE time values as negative years', async () => {
    const entity = await client.getEntity('Q160387');
    expect(parseWikidataYear(entity.claims.P585?.[0]?.time ?? '')).toBe(-31);
    expect(parseWikidataYear('-0044-03-15T00:00:00Z')).toBe(-44);
  });

  it('exposes year precision and leaves month/day null', async () => {
    const entity = await client.getEntity('Q2269');
    const start = entity.claims.P580?.[0];
    expect(start?.precision).toBe(9);
    expect(start?.time).toBe('+1760-00-00T00:00:00Z');
    expect(parseWikidataTime(start?.time ?? '')).toEqual({
      year: 1760,
      month: null,
      day: null,
    });
  });
});
