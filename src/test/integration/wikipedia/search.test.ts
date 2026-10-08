import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { RateLimiter } from '../../../lib/wikipedia/rateLimit';
import { createWikipediaClient } from '../../../lib/wikipedia/wikipediaClient';
import {
  createWikidataClient,
  type WikidataClient,
} from '../../../lib/wikipedia/wikidataClient';
import { createResolver, type Resolver } from '../../../lib/wikipedia/qidResolver';
import { createSearchService } from '../../../lib/wikipedia/search';
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

describe('SearchService', () => {
  let store: FixtureStore;
  let wikipedia: ReturnType<typeof createWikipediaClient>;
  let service: ReturnType<typeof createSearchService>;

  beforeAll(async () => {
    store = createFixtureStore();
    await store.loadDirectory(WIKIPEDIA_DIR);
    await store.loadDirectory(WIKIDATA_DIR);
    const fetchFn = store.buildFetch();
    wikipedia = createWikipediaClient({
      contactEmail: CONTACT_EMAIL,
      fetchFn,
      rateLimiter: fastLimiter(),
    });
    const wikidata = createWikidataClient({
      contactEmail: CONTACT_EMAIL,
      fetchFn,
      rateLimiter: fastLimiter(),
    });
    const resolver = createResolver(wikidata);
    service = createSearchService({ wikipedia, wikidata, resolver });
  });

  it('attaches resolved QIDs to search candidates', async () => {
    const candidates = await service.search('Treaty of Versailles');
    expect(candidates.length).toBeGreaterThan(0);
    const top = candidates[0];
    expect(top?.title).toBe('Treaty of Versailles');
    expect(top?.resolvedQid).toBe('Q8736');
    expect(top?.qidConfidence).toBe('HIGH');
  });

  it('returns multiple candidates each with their own QID for ambiguous terms', async () => {
    const candidates = await service.search('Napoleon');
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    const resolved = candidates
      .map((candidate) => candidate.resolvedQid)
      .filter((qid): qid is string => qid !== null);
    expect(resolved.length).toBeGreaterThanOrEqual(2);
    expect(new Set(resolved).size).toBe(resolved.length);
  });

  it('returns an empty array for a zero-result query', async () => {
    await expect(service.search('Fictional nonsense query xyzabc')).resolves.toEqual(
      [],
    );
  });

  it('tolerates per-candidate resolution failures', async () => {
    const failingWikidata: WikidataClient = {
      search: async () => {
        throw new Error('wikidata down');
      },
      getEntity: async () => {
        throw new Error('wikidata down');
      },
      resolveRedirect: async (qid: string) => qid,
      getQidForWikipediaTitle: async () => {
        throw new Error('wikidata down');
      },
    };
    const failingResolver: Resolver = {
      resolve: async () => {
        throw new Error('resolver down');
      },
    };
    const failingService = createSearchService({
      wikipedia,
      wikidata: failingWikidata,
      resolver: failingResolver,
    });

    const candidates = await failingService.search('Treaty of Versailles');
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.resolvedQid).toBeNull();
      expect(candidate.qidConfidence).toBe('NONE');
    }
  });

  it('strips HTML tags from snippets', async () => {
    const candidates = await service.search('Treaty of Versailles');
    for (const candidate of candidates) {
      expect(candidate.snippet).not.toContain('<');
      expect(candidate.snippet).not.toContain('>');
    }
  });

  it('preserves Wikipedia search ranking order', async () => {
    const raw = await wikipedia.search('Treaty of Versailles');
    const candidates = await service.search('Treaty of Versailles');
    expect(candidates.map((candidate) => candidate.title)).toEqual(
      raw.map((result) => result.title),
    );
  });
});
