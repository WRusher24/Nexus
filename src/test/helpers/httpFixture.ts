/**
 * Fixture-backed `fetch` for tests (Milestone 5).
 *
 * Recorded HTTP responses live as JSON files under
 * `src/test/fixtures/wikipedia/` and `src/test/fixtures/wikidata/`. Each file
 * has the shape:
 *
 *   {
 *     "url": "https://en.wikipedia.org/w/api.php?...",
 *     "method": "GET",
 *     "status": 200,
 *     "headers": { "content-type": "application/json" },
 *     "body": { ...parsed JSON or a raw string... }
 *   }
 *
 * Fixtures are keyed by a normalised (method + URL) pair, where query
 * parameters are sorted and re-encoded so that parameter order and encoding
 * differences do not cause spurious misses.
 *
 * No test in this suite performs a live network call; every client is
 * constructed with `createFixtureStore().buildFetch()`.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface HttpFixture {
  url: string;
  method: 'GET' | 'POST';
  status: number;
  headers?: Record<string, string>;
  /** JSON-parsed body (object/array) OR a raw string for text responses. */
  body: unknown;
}

export interface FixtureStore {
  register(fixture: HttpFixture): void;
  loadDirectory(dir: string): Promise<void>;
  buildFetch(): typeof fetch;
  clear(): void;
  getHits(): string[];
}

/**
 * Canonicalise a URL for fixture matching: keep origin + path, sort query
 * parameters by key then value, and re-encode each with `encodeURIComponent`.
 */
export function normalizeUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  const entries = Array.from(parsed.searchParams.entries()).map(
    ([key, value]) => [key, value] as const,
  );
  entries.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
  });
  const query = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return `${parsed.origin}${parsed.pathname}${query ? `?${query}` : ''}`;
}

function fixtureKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${normalizeUrl(url)}`;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input === 'object' && !(input instanceof URL) && 'method' in input) {
    return input.method.toUpperCase();
  }
  return 'GET';
}

export function createFixtureStore(): FixtureStore {
  const fixtures = new Map<string, HttpFixture>();
  const hits: string[] = [];

  function register(fixture: HttpFixture): void {
    fixtures.set(fixtureKey(fixture.method, fixture.url), fixture);
  }

  async function loadDirectory(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const raw = await readFile(join(dir, entry.name), 'utf8');
      const fixture = JSON.parse(raw) as HttpFixture;
      register(fixture);
    }
  }

  function buildFetch(): typeof fetch {
    const fetchFn = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const method = requestMethod(input, init);
      const url = requestUrl(input);
      const key = fixtureKey(method, url);
      const fixture = fixtures.get(key);
      if (!fixture) {
        throw new Error(
          `No HTTP fixture registered for ${key}.\nRequested URL: ${url}`,
        );
      }
      hits.push(key);

      const bodyText =
        typeof fixture.body === 'string'
          ? fixture.body
          : JSON.stringify(fixture.body);
      const headers = new Headers(fixture.headers ?? {});
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
      return new Response(bodyText, { status: fixture.status, headers });
    };
    return fetchFn as unknown as typeof fetch;
  }

  function clear(): void {
    fixtures.clear();
    hits.length = 0;
  }

  function getHits(): string[] {
    return [...hits];
  }

  return { register, loadDirectory, buildFetch, clear, getHits };
}
