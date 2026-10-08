/**
 * Wikidata HTTP client (Milestone 5).
 *
 * Resolves entities by search, QID, Wikipedia sitelink, and redirect. Shares
 * the MediaWiki request helper, retry policy, User-Agent, and `WikipediaError`
 * class with the Wikipedia client.
 */

import { RateLimiter } from './rateLimit';
import {
  buildUserAgent,
  mediaWikiJsonRequest,
  WikipediaError,
} from './wikipediaClient';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface WikidataSearchResult {
  qid: string;
  label: string;
  description: string | null;
  aliases: string[];
  match: {
    text: string;
    language: string;
    type: 'label' | 'alias' | 'description';
  };
}

export interface WikidataTimeValue {
  /** ISO-like time string, e.g. "+1914-07-28T00:00:00Z" or "-0044-00-00T00:00:00Z". */
  time: string;
  /** 7=century, 8=decade, 9=year, 10=month, 11=day (plus 6=millennium, 0-5 rougher). */
  precision: number;
  /** Calendar model QID, e.g. Q1985727 (Gregorian). */
  calendarmodel: string;
}

export interface WikidataEntity {
  qid: string;
  label: string;
  description: string | null;
  aliases: string[];
  wikipediaTitle: string | null;
  claims: {
    P585?: WikidataTimeValue[];
    P580?: WikidataTimeValue[];
    P582?: WikidataTimeValue[];
    P571?: WikidataTimeValue[];
  };
  instanceOf: string[];
}

export interface ParsedWikidataTime {
  year: number | null;
  month: number | null;
  day: number | null;
}

/**
 * Parse the year/month/day from a Wikidata time string. Month and day are
 * `00` when below the claim's precision; those are returned as `null`.
 * BCE years are negative (Wikidata uses a leading `-`).
 */
export function parseWikidataTime(time: string): ParsedWikidataTime {
  const match = /^([+-])(\d+)-(\d{2})-(\d{2})/.exec(time);
  if (!match) return { year: null, month: null, day: null };
  const sign = match[1] === '-' ? -1 : 1;
  const year = Number.parseInt(match[2] ?? '', 10) * sign;
  const month = Number.parseInt(match[3] ?? '', 10);
  const day = Number.parseInt(match[4] ?? '', 10);
  return {
    year: Number.isNaN(year) ? null : year,
    month: month === 0 ? null : month,
    day: day === 0 ? null : day,
  };
}

/** Extract just the signed year from a Wikidata time string (null if invalid). */
export function parseWikidataYear(time: string): number | null {
  return parseWikidataTime(time).year;
}

export interface WikidataClient {
  search(query: string, limit?: number): Promise<WikidataSearchResult[]>;
  getEntity(qid: string): Promise<WikidataEntity>;
  resolveRedirect(qid: string): Promise<string>;
  getQidForWikipediaTitle(
    title: string,
    languageCode?: string,
  ): Promise<string | null>;
}

export interface WikidataClientOptions {
  contactEmail: string;
  rateLimiter?: RateLimiter;
  fetchFn?: typeof fetch;
  /** Test seam: overrides the retry backoff sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export const WIKIDATA_API_BASE = 'https://www.wikidata.org/w/api.php';

// ─────────────────────────────────────────────────────────────────────────────
// URL builders (exported for the fixture-recording script)
// ─────────────────────────────────────────────────────────────────────────────

function apiUrl(params: Record<string, string>): string {
  const search = new URLSearchParams(params);
  return `${WIKIDATA_API_BASE}?${search.toString()}`;
}

export function buildWikidataSearchUrl(query: string, limit: number): string {
  return apiUrl({
    action: 'wbsearchentities',
    search: query,
    language: 'en',
    limit: String(limit),
    format: 'json',
  });
}

export function buildWikidataEntityUrl(qid: string): string {
  return apiUrl({
    action: 'wbgetentities',
    ids: qid,
    props: 'labels|descriptions|aliases|claims|sitelinks',
    languages: 'en',
    sitefilter: 'enwiki',
    format: 'json',
  });
}

export function buildWikidataInfoUrl(qid: string): string {
  return apiUrl({
    action: 'wbgetentities',
    ids: qid,
    props: 'info',
    format: 'json',
  });
}

export function buildWikidataSitelinkUrl(
  title: string,
  languageCode: string,
): string {
  return apiUrl({
    action: 'wbgetentities',
    sites: `${languageCode}wiki`,
    titles: title,
    props: 'info',
    format: 'json',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Raw response narrowing helpers
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface RawSnak {
  snaktype?: string;
  datatype?: string;
  datavalue?: { value?: unknown };
}

interface RawClaim {
  mainsnak?: RawSnak;
}

interface RawEntity {
  id?: string;
  missing?: unknown;
  redirects?: { from?: string; to?: string };
  labels?: Record<string, { value?: string }>;
  descriptions?: Record<string, { value?: string }>;
  aliases?: Record<string, Array<{ value?: string }>>;
  claims?: Record<string, RawClaim[]>;
  sitelinks?: Record<string, { title?: string }>;
}

interface RawEntitiesResponse {
  entities?: Record<string, RawEntity>;
  search?: Array<{
    id?: string;
    label?: string;
    description?: string;
    display?: {
      label?: { value?: string; language?: string };
      description?: { value?: string };
    };
    match?: { type?: string; language?: string; text?: string };
  }>;
}

function englishValue(
  map: Record<string, { value?: string }> | undefined,
): string | null {
  const entry = map?.en;
  return typeof entry?.value === 'string' ? entry.value : null;
}

function normalizeCalendarModel(raw: string): string {
  const slash = raw.lastIndexOf('/');
  return slash === -1 ? raw : raw.slice(slash + 1);
}

function parseTimeClaims(
  claims: RawClaim[] | undefined,
): WikidataTimeValue[] {
  const values: WikidataTimeValue[] = [];
  for (const claim of claims ?? []) {
    const snak = claim.mainsnak;
    if (!snak || snak.snaktype !== 'value') continue;
    const value = snak.datavalue?.value;
    if (
      isRecord(value) &&
      typeof value.time === 'string' &&
      typeof value.precision === 'number'
    ) {
      values.push({
        time: value.time,
        precision: value.precision,
        calendarmodel:
          typeof value.calendarmodel === 'string'
            ? normalizeCalendarModel(value.calendarmodel)
            : '',
      });
    }
  }
  return values;
}

function parseInstanceOf(claims: RawClaim[] | undefined): string[] {
  const ids: string[] = [];
  for (const claim of claims ?? []) {
    const snak = claim.mainsnak;
    if (!snak || snak.snaktype !== 'value') continue;
    const value = snak.datavalue?.value;
    if (isRecord(value) && typeof value.id === 'string') {
      ids.push(value.id);
    }
  }
  return ids;
}

function toEntity(entity: RawEntity, requestedQid: string): WikidataEntity {
  const claims = entity.claims ?? {};
  return {
    qid: typeof entity.id === 'string' ? entity.id : requestedQid,
    label: englishValue(entity.labels) ?? '',
    description: englishValue(entity.descriptions),
    aliases: (entity.aliases?.en ?? [])
      .map((alias) => alias.value)
      .filter((value): value is string => typeof value === 'string'),
    wikipediaTitle: entity.sitelinks?.enwiki?.title ?? null,
    claims: {
      ...(claims.P585 ? { P585: parseTimeClaims(claims.P585) } : {}),
      ...(claims.P580 ? { P580: parseTimeClaims(claims.P580) } : {}),
      ...(claims.P582 ? { P582: parseTimeClaims(claims.P582) } : {}),
      ...(claims.P571 ? { P571: parseTimeClaims(claims.P571) } : {}),
    },
    instanceOf: parseInstanceOf(claims.P31),
  };
}

function normalizeMatchType(
  raw: string | undefined,
): 'label' | 'alias' | 'description' {
  if (raw === 'alias' || raw === 'description') return raw;
  return 'label';
}

// ─────────────────────────────────────────────────────────────────────────────
// Client
// ─────────────────────────────────────────────────────────────────────────────

export function createWikidataClient(
  options: WikidataClientOptions,
): WikidataClient {
  if (typeof options.contactEmail !== 'string' || options.contactEmail.trim() === '') {
    throw new Error(
      'WikidataClient: contactEmail is required (API etiquette).',
    );
  }

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
  ): Promise<WikidataSearchResult[]> {
    if (query.trim() === '') return [];
    const json = await request<RawEntitiesResponse>(
      buildWikidataSearchUrl(query, limit),
    );
    return (json.search ?? [])
      .filter((item): item is typeof item & { id: string } => typeof item.id === 'string')
      .map((item) => ({
        qid: item.id,
        label: item.label ?? item.display?.label?.value ?? '',
        description: item.description ?? item.display?.description?.value ?? null,
        aliases: [],
        match: {
          text: item.match?.text ?? query,
          language: item.match?.language ?? 'en',
          type: normalizeMatchType(item.match?.type),
        },
      }));
  }

  async function getEntity(qid: string): Promise<WikidataEntity> {
    const json = await request<RawEntitiesResponse>(buildWikidataEntityUrl(qid));
    const entity = json.entities?.[qid];
    if (!entity || entity.missing !== undefined) {
      throw new WikipediaError('PAGE_NOT_FOUND', `Wikidata entity ${qid}`);
    }
    return toEntity(entity, qid);
  }

  async function resolveRedirect(qid: string): Promise<string> {
    const json = await request<RawEntitiesResponse>(buildWikidataInfoUrl(qid));
    const entity = json.entities?.[qid];
    if (!entity || entity.missing !== undefined) {
      return qid;
    }
    if (typeof entity.redirects?.to === 'string' && entity.redirects.to !== '') {
      return entity.redirects.to;
    }
    return typeof entity.id === 'string' ? entity.id : qid;
  }

  async function getQidForWikipediaTitle(
    title: string,
    languageCode = 'en',
  ): Promise<string | null> {
    const json = await request<RawEntitiesResponse>(
      buildWikidataSitelinkUrl(title, languageCode),
    );
    const entities = json.entities ?? {};
    for (const key of Object.keys(entities)) {
      const entity = entities[key];
      if (!entity) continue;
      if (key === '-1' || entity.missing !== undefined) continue;
      if (typeof entity.id === 'string' && entity.id !== '') return entity.id;
    }
    return null;
  }

  return { search, getEntity, resolveRedirect, getQidForWikipediaTitle };
}
