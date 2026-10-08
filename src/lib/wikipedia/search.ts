/**
 * Wikipedia search + disambiguation service (Milestone 5).
 *
 * Wraps a Wikipedia search with a best-effort QID resolution for every
 * candidate so a caller (or test) can present a disambiguation list in which
 * each entry already carries its canonical Wikidata QID when one is known.
 *
 * Resolution strategy per candidate:
 *   1. Direct sitelink lookup (`getQidForWikipediaTitle`) — most reliable.
 *   2. Fallback to the name-based resolver.
 * Resolution failures are tolerated: the candidate is still returned with
 * `resolvedQid = null` and confidence `NONE`.
 */

import type { ResolverConfidence } from './types';
import type { Resolver } from './qidResolver';
import type {
  WikipediaClient,
  WikipediaSearchResult,
} from './wikipediaClient';
import type { WikidataClient } from './wikidataClient';

export interface DisambiguationCandidate {
  pageId: number;
  title: string;
  snippet: string;
  wordCount: number;
  resolvedQid: string | null;
  qidConfidence: ResolverConfidence;
}

export interface SearchService {
  search(query: string, limit?: number): Promise<DisambiguationCandidate[]>;
}

export interface SearchServiceOptions {
  wikipedia: WikipediaClient;
  wikidata: WikidataClient;
  resolver: Resolver;
}

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

/** Strip HTML tags and decode the handful of entities MediaWiki emits. */
export function stripHtmlSnippet(snippet: string): string {
  const withoutTags = snippet.replace(/<[^>]+>/g, '');
  return withoutTags.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) =>
    HTML_ENTITIES[entity] ?? entity,
  );
}

export function createSearchService(options: SearchServiceOptions): SearchService {
  const { wikipedia, wikidata, resolver } = options;

  async function resolveCandidate(
    result: WikipediaSearchResult,
  ): Promise<{ qid: string | null; confidence: ResolverConfidence }> {
    try {
      const direct = await wikidata.getQidForWikipediaTitle(result.title);
      if (direct) return { qid: direct, confidence: 'HIGH' };
    } catch {
      // Fall through to the name-based resolver.
    }

    try {
      const resolved = await resolver.resolve(result.title);
      if (resolved.qid) {
        return { qid: resolved.qid, confidence: resolved.confidence };
      }
    } catch {
      // Tolerate resolution failures below.
    }

    return { qid: null, confidence: 'NONE' };
  }

  async function search(
    query: string,
    limit = 5,
  ): Promise<DisambiguationCandidate[]> {
    const results = await wikipedia.search(query, limit);
    const candidates: DisambiguationCandidate[] = [];

    for (const result of results) {
      const { qid, confidence } = await resolveCandidate(result);
      candidates.push({
        pageId: result.pageId,
        title: result.title,
        snippet: stripHtmlSnippet(result.snippet),
        wordCount: result.wordCount,
        resolvedQid: qid,
        qidConfidence: confidence,
      });
    }

    return candidates;
  }

  return { search };
}
