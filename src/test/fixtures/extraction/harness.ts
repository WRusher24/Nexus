/**
 * Shared scaffolding for extraction tests (Milestone 6).
 *
 * The orchestrator and validation pipeline depend on external services
 * (a source-document service, a Wikidata resolver, and the HTTP clients),
 * all injected through config. Tests substitute deterministic stubs so no
 * network is ever touched. The LLM is stubbed separately via the fixture
 * provider.
 */

import { randomUUID } from 'node:crypto';
import type {
  DateField,
  ExtractionOutput,
  ProposedEdge,
  RelatedEntity,
} from '../../../lib/extraction/schema';
import type { SectionInfo } from '../../../lib/wikipedia/types';
import type {
  CachedSourceDocument,
  SourceDocumentService,
} from '../../../lib/wikipedia/sourceDocuments';
import type { Resolver, ResolverResult } from '../../../lib/wikipedia/qidResolver';
import type { ResolverConfidence } from '../../../lib/wikipedia/types';
import type {
  WikipediaArticle,
  WikipediaClient,
  WikipediaSearchResult,
} from '../../../lib/wikipedia/wikipediaClient';
import type { WikidataClient } from '../../../lib/wikipedia/wikidataClient';
import { sha256 } from '../../../lib/wikipedia/parser';

// ─────────────────────────────────────────────────────────────────────────────
// ExtractionOutput builders
// ─────────────────────────────────────────────────────────────────────────────

export function dateField(overrides: Partial<DateField> = {}): DateField {
  return {
    year: 1900,
    month: null,
    day: null,
    precision: 'YEAR',
    ...overrides,
  };
}

export function unknownDate(): DateField {
  return { year: null, month: null, day: null, precision: 'UNKNOWN' };
}

export function relatedEntity(overrides: Partial<RelatedEntity> = {}): RelatedEntity {
  return {
    name: 'Related entity',
    entityType: 'EVENT',
    dateStart: dateField(),
    dateEnd: dateField(),
    disambiguationHint: {
      description: 'test entity',
      approximateDateRange: '1900',
    },
    ...overrides,
  };
}

export function evidenceQuote(verbatimQuote: string, sectionTitle = 'Lead') {
  return { verbatimQuote, sectionTitle };
}

export function proposedEdge(overrides: {
  relatedEntity?: Partial<RelatedEntity>;
  relationType?: ProposedEdge['relationType'];
  importanceRank?: number;
  contested?: boolean;
  verbatimQuote: string;
  sectionTitle?: string;
}): ProposedEdge {
  return {
    relatedEntity: relatedEntity(overrides.relatedEntity ?? {}),
    relationType: overrides.relationType ?? 'CAUSED',
    importanceRank: overrides.importanceRank ?? 1,
    contested: overrides.contested ?? false,
    evidence: evidenceQuote(
      overrides.verbatimQuote,
      overrides.sectionTitle ?? 'Lead',
    ),
  };
}

export function extractionOutput(overrides: {
  focalName?: string;
  focalType?: RelatedEntity['entityType'];
  focalDates?: Partial<DateField>;
  direction?: 'UPSTREAM' | 'DOWNSTREAM';
  edges?: ProposedEdge[];
  sparsenessReason?: string | null;
  feedbackLoopsDecomposed?: boolean;
}): ExtractionOutput {
  return {
    focalEntity: {
      name: overrides.focalName ?? 'Focal entity',
      entityType: overrides.focalType ?? 'EVENT',
      dateStart: dateField(overrides.focalDates ?? {}),
      dateEnd: dateField(overrides.focalDates ?? {}),
    },
    direction: overrides.direction ?? 'UPSTREAM',
    edges: overrides.edges ?? [],
    metadata: {
      sparsenessReason: overrides.sparsenessReason ?? null,
      feedbackLoopsDecomposed: overrides.feedbackLoopsDecomposed ?? false,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Service stubs
// ─────────────────────────────────────────────────────────────────────────────

export interface StubSourceDocumentInput {
  rawText: string;
  sectionIndex: SectionInfo[];
  wikipediaPageId?: number;
  wikipediaTitle?: string;
  revisionId?: number;
  id?: string;
}

export function createStubSourceDocumentService(
  input: StubSourceDocumentInput,
): SourceDocumentService & { readonly document: CachedSourceDocument } {
  const document: CachedSourceDocument = {
    id: input.id ?? randomUUID(),
    wikipediaPageId: input.wikipediaPageId ?? 4242,
    wikipediaTitle: input.wikipediaTitle ?? 'Stub article',
    revisionId: input.revisionId ?? 123456,
    rawText: input.rawText,
    contentHash: sha256(input.rawText),
    sectionIndex: input.sectionIndex,
    languageCode: 'en',
  };
  return {
    document,
    async fetchAndStore() {
      return document;
    },
    async getByRevision() {
      return document;
    },
    async getLatest() {
      return document;
    },
  };
}

export interface StubResolverEntry {
  qid: string | null;
  confidence: ResolverConfidence;
  wikipediaTitle?: string | null;
  score?: number;
}

function emptyResolverResult(): ResolverResult {
  return {
    qid: null,
    wikipediaTitle: null,
    confidence: 'NONE',
    score: 0,
    scoreBreakdown: { nameMatch: 0, typeMatch: 0, dateMatch: 0, descriptionMatch: 0 },
    candidates: [],
  };
}

/**
 * Deterministic resolver: entity name -> recorded result. Unknown names return
 * confidence NONE.
 */
export function createStubResolver(
  entries: Record<string, StubResolverEntry>,
): Resolver {
  return {
    async resolve(name: string): Promise<ResolverResult> {
      const entry = entries[name];
      if (!entry) return emptyResolverResult();
      const base = emptyResolverResult();
      return {
        ...base,
        qid: entry.qid,
        wikipediaTitle: entry.wikipediaTitle ?? null,
        confidence: entry.confidence,
        score: entry.score ?? 0,
        candidates: entry.qid
          ? [{ qid: entry.qid, label: name, description: null, score: entry.score ?? 0 }]
          : [],
      };
    },
  };
}

export function createUnusedWikipediaClient(): WikipediaClient {
  const fail = (): never => {
    throw new Error('WikipediaClient stub was called unexpectedly');
  };
  return {
    async search(): Promise<WikipediaSearchResult[]> {
      return fail();
    },
    async fetchArticleByPageId(): Promise<WikipediaArticle> {
      return fail();
    },
    async fetchArticleByTitle(): Promise<WikipediaArticle | null> {
      return fail();
    },
    async fetchArticleByRevisionId(): Promise<WikipediaArticle> {
      return fail();
    },
  };
}

export function createUnusedWikidataClient(): WikidataClient {
  const fail = (): never => {
    throw new Error('WikidataClient stub was called unexpectedly');
  };
  return {
    async search() {
      return fail();
    },
    async getEntity() {
      return fail();
    },
    async resolveRedirect() {
      return fail();
    },
    async getQidForWikipediaTitle() {
      return fail();
    },
  };
}
