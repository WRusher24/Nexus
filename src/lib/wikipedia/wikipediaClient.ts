/**
 * MediaWiki (Wikipedia) HTTP client (Milestone 5).
 *
 * Responsibilities:
 *   - full-text search
 *   - revision-pinned article fetch (plain text + section index)
 *   - redirect-following title resolution and disambiguation detection
 *   - mandatory User-Agent, rate limiting, and retry/backoff
 *
 * All network access is routed through an injectable `fetchFn` so tests can
 * serve recorded fixtures instead of hitting the live API. Production passes
 * nothing and the client uses the global `fetch`.
 */

import { parseArticleText, sha256 } from './parser';
import { RateLimiter } from './rateLimit';
import type { SectionInfo } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export type WikipediaErrorCode =
  | 'PAGE_NOT_FOUND'
  | 'DISAMBIGUATION'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'INVALID_RESPONSE'
  | 'NETWORK_ERROR';

export class WikipediaError extends Error {
  constructor(
    public code: WikipediaErrorCode,
    public detail: string,
    public status?: number,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'WikipediaError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface WikipediaSearchResult {
  pageId: number;
  title: string;
  snippet: string;
  wordCount: number;
}

export interface WikipediaArticle {
  pageId: number;
  title: string;
  revisionId: number;
  plainText: string;
  sections: SectionInfo[];
  contentHash: string;
  languageCode: string;
}

export interface WikipediaClientOptions {
  contactEmail: string;
  languageCode?: string;
  rateLimiter?: RateLimiter;
  fetchFn?: typeof fetch;
  /**
   * Test seam: overrides the retry backoff sleep. Production omits it and the
   * client uses real timers (1s/2s/4s / 5s per the retry policy).
   */
  sleep?: (ms: number) => Promise<void>;
}

export interface WikipediaClient {
  search(query: string, limit?: number): Promise<WikipediaSearchResult[]>;
  fetchArticleByPageId(pageId: number): Promise<WikipediaArticle>;
  fetchArticleByTitle(title: string): Promise<WikipediaArticle | null>;
  fetchArticleByRevisionId(revisionId: number): Promise<WikipediaArticle>;
}

/** The canonical User-Agent format mandated by Wikipedia's API etiquette. */
export function buildUserAgent(contactEmail: string): string {
  return `Nexus/1.0 (${contactEmail}) nexus-history-graph`;
}

export const WIKIPEDIA_API_HOST = 'https://en.wikipedia.org';

// ─────────────────────────────────────────────────────────────────────────────
// URL builders (exported so the fixture-recording script builds identical URLs)
// ─────────────────────────────────────────────────────────────────────────────

function queryUrl(apiBase: string, params: Record<string, string>): string {
  const search = new URLSearchParams(params);
  return `${apiBase}?${search.toString()}`;
}

export function buildSearchUrl(
  apiBase: string,
  query: string,
  limit: number,
): string {
  return queryUrl(apiBase, {
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: String(limit),
    format: 'json',
    formatversion: '2',
  });
}

export function buildTitleResolveUrl(apiBase: string, title: string): string {
  return queryUrl(apiBase, {
    action: 'query',
    titles: title,
    redirects: '1',
    prop: 'revisions|pageprops',
    rvprop: 'ids',
    format: 'json',
    formatversion: '2',
  });
}

export function buildArticleByPageIdUrl(apiBase: string, pageId: number): string {
  return queryUrl(apiBase, {
    action: 'query',
    pageids: String(pageId),
    prop: 'extracts|revisions|pageprops',
    explaintext: '1',
    exsectionformat: 'plain',
    rvprop: 'ids',
    rvlimit: '1',
    format: 'json',
    formatversion: '2',
  });
}

export function buildArticleByRevisionIdUrl(
  apiBase: string,
  revisionId: number,
): string {
  return queryUrl(apiBase, {
    action: 'query',
    revids: String(revisionId),
    prop: 'extracts|revisions|pageprops',
    explaintext: '1',
    exsectionformat: 'plain',
    rvprop: 'ids',
    format: 'json',
    formatversion: '2',
  });
}

export function buildSectionsByPageIdUrl(apiBase: string, pageId: number): string {
  return queryUrl(apiBase, {
    action: 'parse',
    pageid: String(pageId),
    prop: 'sections',
    format: 'json',
    formatversion: '2',
  });
}

export function buildSectionsByRevisionIdUrl(
  apiBase: string,
  revisionId: number,
): string {
  return queryUrl(apiBase, {
    action: 'parse',
    oldid: String(revisionId),
    prop: 'sections',
    format: 'json',
    formatversion: '2',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared HTTP helper (also used by the Wikidata client)
// ─────────────────────────────────────────────────────────────────────────────

export interface MediaWikiRequestOptions {
  url: string;
  fetchFn: typeof fetch;
  rateLimiter: RateLimiter;
  userAgent: string;
  sleep?: (ms: number) => Promise<void>;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const SERVER_BACKOFF_MS = [1000, 2000, 4000] as const;
const FINAL_BACKOFF_MS = 4000;
const RATE_LIMIT_PAUSE_MS = 5000;
const MAX_RETRIES = 3;

async function responseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable body>';
  }
}

/**
 * Perform a JSON GET against a MediaWiki-family API with shared retry policy:
 *   - 429: pause 5s, retry once, then RATE_LIMITED
 *   - 5xx: 3 retries with 1s/2s/4s backoff, then SERVER_ERROR
 *   - network error: 3 retries, then NETWORK_ERROR
 *   - 404: PAGE_NOT_FOUND (no retry)
 *   - other non-2xx: INVALID_RESPONSE
 */
export async function mediaWikiJsonRequest<T>(
  options: MediaWikiRequestOptions,
): Promise<T> {
  const sleep = options.sleep ?? realSleep;
  let rateLimitRetried = false;

  for (let attempt = 0; ; attempt += 1) {
    await options.rateLimiter.acquire();

    let response: Response;
    try {
      response = await options.fetchFn(options.url, {
        method: 'GET',
        headers: {
          'User-Agent': options.userAgent,
          Accept: 'application/json',
        },
      });
    } catch (error) {
      if (attempt < MAX_RETRIES) {
        await sleep(SERVER_BACKOFF_MS[attempt] ?? FINAL_BACKOFF_MS);
        continue;
      }
      throw new WikipediaError(
        'NETWORK_ERROR',
        `request to ${options.url} failed: ${String(error)}`,
      );
    }

    if (response.status === 429) {
      if (!rateLimitRetried) {
        rateLimitRetried = true;
        await sleep(RATE_LIMIT_PAUSE_MS);
        continue;
      }
      throw new WikipediaError('RATE_LIMITED', options.url, 429);
    }

    if (response.status >= 500) {
      if (attempt < MAX_RETRIES) {
        await sleep(SERVER_BACKOFF_MS[attempt] ?? FINAL_BACKOFF_MS);
        continue;
      }
      throw new WikipediaError('SERVER_ERROR', options.url, response.status);
    }

    if (response.status === 404) {
      throw new WikipediaError('PAGE_NOT_FOUND', options.url, 404);
    }

    if (!response.ok) {
      const body = await responseText(response);
      throw new WikipediaError(
        'INVALID_RESPONSE',
        `HTTP ${response.status} from ${options.url}: ${body.slice(0, 500)}`,
        response.status,
      );
    }

    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new WikipediaError(
        'INVALID_RESPONSE',
        `invalid JSON from ${options.url}: ${String(error)}`,
        response.status,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal API response shapes
// ─────────────────────────────────────────────────────────────────────────────

interface SearchApiItem {
  pageid?: number;
  title?: string;
  snippet?: string;
  wordcount?: number;
}

interface ApiQueryPage {
  pageid?: number;
  title?: string;
  missing?: unknown;
  extract?: string;
  revisions?: Array<{ revid?: number }>;
  pageprops?: Record<string, unknown>;
}

interface ApiQueryResponse {
  query?: {
    pages?: ApiQueryPage[];
    search?: SearchApiItem[];
  };
}

interface ApiParseSectionsResponse {
  parse?: {
    sections?: Array<{ line?: string }>;
  };
}

function isMissingPage(page: ApiQueryPage | undefined): boolean {
  if (!page) return true;
  return page.missing !== undefined || page.pageid === undefined || page.pageid === -1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Client
// ─────────────────────────────────────────────────────────────────────────────

export function createWikipediaClient(
  options: WikipediaClientOptions,
): WikipediaClient {
  if (typeof options.contactEmail !== 'string' || options.contactEmail.trim() === '') {
    throw new Error(
      'WikipediaClient: contactEmail is required (Wikipedia API etiquette).',
    );
  }

  const languageCode = options.languageCode ?? 'en';
  const apiBase = `https://${languageCode}.wikipedia.org/w/api.php`;
  const userAgent = buildUserAgent(options.contactEmail);
  const rateLimiter = options.rateLimiter ?? new RateLimiter({ requestsPerSecond: 10 });
  const fetchFn: typeof fetch =
    options.fetchFn ?? ((input, init) => globalThis.fetch(input, init));

  const request = <T>(url: string): Promise<T> =>
    mediaWikiJsonRequest<T>({
      url,
      fetchFn,
      rateLimiter,
      userAgent,
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });

  async function search(
    query: string,
    limit = 5,
  ): Promise<WikipediaSearchResult[]> {
    if (query.trim() === '') return [];
    const json = await request<ApiQueryResponse>(
      buildSearchUrl(apiBase, query, limit),
    );
    const items = json.query?.search ?? [];
    return items.map((item) => ({
      pageId: item.pageid ?? -1,
      title: item.title ?? '',
      snippet: item.snippet ?? '',
      wordCount: item.wordcount ?? 0,
    }));
  }

  async function fetchSectionTitlesByPageId(pageId: number): Promise<string[]> {
    const json = await request<ApiParseSectionsResponse>(
      buildSectionsByPageIdUrl(apiBase, pageId),
    );
    return (json.parse?.sections ?? [])
      .map((section) => section.line)
      .filter((line): line is string => typeof line === 'string' && line !== '');
  }

  async function fetchSectionTitlesByRevisionId(
    revisionId: number,
  ): Promise<string[]> {
    const json = await request<ApiParseSectionsResponse>(
      buildSectionsByRevisionIdUrl(apiBase, revisionId),
    );
    return (json.parse?.sections ?? [])
      .map((section) => section.line)
      .filter((line): line is string => typeof line === 'string' && line !== '');
  }

  function buildArticle(
    page: ApiQueryPage,
    revisionId: number,
    sectionTitles: string[],
  ): WikipediaArticle {
    const parsed = parseArticleText(page.extract ?? '', sectionTitles);
    return {
      pageId: page.pageid ?? -1,
      title: page.title ?? '',
      revisionId,
      plainText: parsed.plainText,
      sections: parsed.sections,
      contentHash: sha256(parsed.plainText),
      languageCode,
    };
  }

  async function fetchArticleByPageId(pageId: number): Promise<WikipediaArticle> {
    const json = await request<ApiQueryResponse>(
      buildArticleByPageIdUrl(apiBase, pageId),
    );
    const page = json.query?.pages?.[0];
    if (isMissingPage(page) || !page) {
      throw new WikipediaError('PAGE_NOT_FOUND', `pageId ${pageId}`);
    }
    const revisionId = page.revisions?.[0]?.revid;
    if (typeof revisionId !== 'number') {
      throw new WikipediaError(
        'INVALID_RESPONSE',
        `no revision id for pageId ${pageId}`,
      );
    }
    const sectionTitles = await fetchSectionTitlesByPageId(page.pageid ?? pageId);
    return buildArticle(page, revisionId, sectionTitles);
  }

  async function fetchArticleByTitle(
    title: string,
  ): Promise<WikipediaArticle | null> {
    const json = await request<ApiQueryResponse>(
      buildTitleResolveUrl(apiBase, title),
    );
    const page = json.query?.pages?.[0];
    if (isMissingPage(page) || !page) {
      return null;
    }
    if (page.pageprops && 'disambiguation' in page.pageprops) {
      return null;
    }
    return fetchArticleByPageId(page.pageid ?? -1);
  }

  async function fetchArticleByRevisionId(
    revisionId: number,
  ): Promise<WikipediaArticle> {
    const json = await request<ApiQueryResponse>(
      buildArticleByRevisionIdUrl(apiBase, revisionId),
    );
    const page = json.query?.pages?.[0];
    if (isMissingPage(page) || !page) {
      throw new WikipediaError('PAGE_NOT_FOUND', `revisionId ${revisionId}`);
    }
    const resolvedRevision = page.revisions?.[0]?.revid ?? revisionId;
    const sectionTitles = await fetchSectionTitlesByRevisionId(resolvedRevision);
    return buildArticle(page, resolvedRevision, sectionTitles);
  }

  return {
    search,
    fetchArticleByPageId,
    fetchArticleByTitle,
    fetchArticleByRevisionId,
  };
}
