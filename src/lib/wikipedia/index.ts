/**
 * Wikipedia / Wikidata external data layer public surface (Milestone 5).
 */

export { chunkArticle, type ChunkingOptions } from './chunker';

export {
  RateLimiter,
  type RateLimiterOptions,
} from './rateLimit';

export {
  parseArticleText,
  sha256,
  type ParsedArticle,
} from './parser';

export {
  createWikipediaClient,
  buildUserAgent,
  mediaWikiJsonRequest,
  WikipediaError,
  WIKIPEDIA_API_HOST,
  type WikipediaErrorCode,
  type WikipediaSearchResult,
  type WikipediaArticle,
  type WikipediaClient,
  type WikipediaClientOptions,
  type MediaWikiRequestOptions,
} from './wikipediaClient';

export {
  createWikidataClient,
  parseWikidataTime,
  parseWikidataYear,
  WIKIDATA_API_BASE,
  type WikidataSearchResult,
  type WikidataTimeValue,
  type WikidataEntity,
  type WikidataClient,
  type WikidataClientOptions,
  type ParsedWikidataTime,
} from './wikidataClient';

export {
  createResolver,
  mapInstanceOfToNodeType,
  ENTITY_TYPE_TO_P31,
  type Resolver,
  type ResolverHint,
  type ResolverResult,
} from './qidResolver';

export {
  createSearchService,
  stripHtmlSnippet,
  type DisambiguationCandidate,
  type SearchService,
  type SearchServiceOptions,
} from './search';

export {
  createSourceDocumentService,
  type CachedSourceDocument,
  type SourceDocumentService,
  type SourceDocumentServiceOptions,
} from './sourceDocuments';

export type {
  SectionInfo,
  Direction,
  Chunk,
  EntityType,
  ResolverConfidence,
} from './types';
