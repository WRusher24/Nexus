/**
 * One-time fixture recorder (Milestone 5).
 *
 * Runs against the LIVE Wikipedia/Wikidata APIs and writes recorded responses
 * into `src/test/fixtures/{wikipedia,wikidata}/`. The recorded fixtures are
 * checked into the repo; tests never perform live calls.
 *
 * Run with:  pnpm exec tsx scripts/record-fixtures.ts
 *
 * Note: this script is intentionally not part of `pnpm run verify`. Re-run it
 * when you need to add a topic to the fixture set.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { createWikipediaClient } from '../src/lib/wikipedia/wikipediaClient';
import { createWikidataClient } from '../src/lib/wikipedia/wikidataClient';
import { createResolver } from '../src/lib/wikipedia/qidResolver';
import { createSearchService } from '../src/lib/wikipedia/search';
import { normalizeUrl } from '../src/test/helpers/httpFixture';

const CONTACT_EMAIL = 'dev@example.com';
const REPO_ROOT = process.cwd();
const WIKIPEDIA_DIR = join(REPO_ROOT, 'src', 'test', 'fixtures', 'wikipedia');
const WIKIDATA_DIR = join(REPO_ROOT, 'src', 'test', 'fixtures', 'wikidata');

function slugify(url: string, method: string): string {
  const parsed = new URL(normalizeUrl(url));
  const path = parsed.pathname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  const query = parsed.search.replace(/^\?/, '').replace(/[^a-z0-9]+/gi, '-');
  const hash = createHash('sha1').update(`${method} ${url}`).digest('hex').slice(0, 8);
  const base = `${path}-${query}`.replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `${base.slice(0, 80)}-${hash}`;
}

function makeRecordingFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = ((init?.method ?? 'GET') as string).toUpperCase();
    const response = await globalThis.fetch(input, init);
    const clone = response.clone();
    const text = await clone.text();

    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }

    const host = new URL(url).hostname;
    const dir = host.includes('wikidata') ? WIKIDATA_DIR : WIKIPEDIA_DIR;
    await mkdir(dir, { recursive: true });
    const fixture = {
      url,
      method,
      status: response.status,
      headers: {
        'content-type': response.headers.get('content-type') ?? 'application/json',
      },
      body,
    };
    const file = join(dir, `${slugify(url, method)}.json`);
    await writeFile(file, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
    return response;
  }) as typeof fetch;
}

async function main(): Promise<void> {
  const fetchFn = makeRecordingFetch();
  const wikipedia = createWikipediaClient({ contactEmail: CONTACT_EMAIL, fetchFn });
  const wikidata = createWikidataClient({ contactEmail: CONTACT_EMAIL, fetchFn });
  const resolver = createResolver(wikidata);
  const searchService = createSearchService({ wikipedia, wikidata, resolver });

  const topicQueries = [
    'Treaty of Versailles',
    'World War I',
    'Industrial Revolution',
    'Napoleon',
    'Mercury',
    'Fictional nonsense query xyzabc',
  ];

  // 1. Search + article fixtures for the core topics.
  const pageIds: Record<string, number> = {};
  for (const query of topicQueries) {
    const results = await wikipedia.search(query, 5);
    console.log(`search(${JSON.stringify(query)}) -> ${results.length} results`);
    for (const result of results.slice(0, 3)) {
      console.log(`   ${result.pageId}  ${result.title}`);
    }
    const top = results[0];
    if (top) {
      pageIds[query] = top.pageId;
      await wikipedia.fetchArticleByPageId(top.pageId);
      await wikidata.getQidForWikipediaTitle(top.title).catch(() => null);
    }
  }

  // 2. Title resolution (redirects + disambiguation detection).
  for (const title of ['Treaty of Versailles', 'Napoleon', 'Mercury', 'Battle of Actium']) {
    const article = await wikipedia.fetchArticleByTitle(title);
    console.log(`fetchArticleByTitle(${JSON.stringify(title)}) -> ${article ? 'article' : 'null'}`);
  }

  // 3. Revision-pinned fetch (a small article with a known revision id).
  await wikipedia.fetchArticleByRevisionId(1366357557);

  // 4. Wikidata entity fixtures.
  const qids = ['Q8736', 'Q361', 'Q2269', 'Q517', 'Q160387', 'Q308', 'Q925'];
  for (const qid of qids) {
    try {
      const entity = await wikidata.getEntity(qid);
      console.log(
        `getEntity(${qid}) -> ${entity.label} | instanceOf=${entity.instanceOf.join(',')}`,
      );
    } catch (error) {
      console.log(`getEntity(${qid}) FAILED: ${String(error)}`);
    }
  }

  // 5. Sitellink lookups for the ambiguous pages' candidates.
  await wikidata.getQidForWikipediaTitle('Napoleon');
  await wikidata.getQidForWikipediaTitle('Mercury');
  await wikidata.getQidForWikipediaTitle('Battle of Actium');
  await wikidata.getQidForWikipediaTitle('Nonexistent Fictional Page xyz');

  // 6. Redirect resolution (Q840 is a merged item → Q46).
  const redirect = await wikidata.resolveRedirect('Q840');
  console.log(`resolveRedirect(Q840) -> ${redirect}`);

  // 7. Resolver happy path (records Wikidata search + entity fetches).
  const resolved = await resolver.resolve('Treaty of Versailles', {
    entityType: 'POLICY',
    description: 'peace treaty that ended World War I',
    expectedYear: 1919,
  });
  console.log(
    `resolver.resolve('Treaty of Versailles') -> ${resolved.qid} ${resolved.confidence} (${resolved.score})`,
  );

  // 8. Search service (records per-candidate sitelink lookups).
  for (const query of ['Treaty of Versailles', 'Napoleon', 'Mercury', 'Fictional nonsense query xyzabc']) {
    const candidates = await searchService.search(query, 5);
    console.log(`searchService(${JSON.stringify(query)}) -> ${candidates.length} candidates`);
  }

  console.log('Fixture recording complete.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
