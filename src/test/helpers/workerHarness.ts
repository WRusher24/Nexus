/**
 * Shared scaffolding for M7 queue/worker tests.
 *
 * Everything here talks to the real PostgreSQL database. External services
 * (Wikipedia, Wikidata, the LLM) are replaced by the deterministic stubs from
 * the M6 extraction harness; no network is touched.
 */

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../lib/db/schema';
import type { SectionIndexEntry } from '../../lib/db/schema';
import type { ExtractionOutput } from '../../lib/extraction/schema';
import type { ExtractionConfig } from '../../lib/extraction/types';
import { claimNextRequest, type ClaimedRequest } from '../../lib/queue/claim';
import {
  processExpansion,
  type ProcessExpansionResult,
} from '../../lib/queue/processExpansion';
import type { Direction } from '../../lib/wikipedia/types';
import {
  createStubResolver,
  createStubSourceDocumentService,
  createUnusedWikidataClient,
  createUnusedWikipediaClient,
  extractionOutput,
  proposedEdge,
  type StubResolverEntry,
} from '../fixtures/extraction/harness';
import { insertNode } from './fixtures';
import {
  createLlmFixtureStore,
  fixtureResponse,
  registerWildcard,
} from './llmFixture';

export type Db = NodePgDatabase<typeof schema>;

// ─────────────────────────────────────────────────────────────────────────────
// Reusable article + edges
// ─────────────────────────────────────────────────────────────────────────────

export const SCENARIO_LEAD =
  'World War I was a global conflict that lasted from 1914 to 1918. It reshaped the political order of Europe.';
export const SCENARIO_CAUSES =
  'The assassination of Archduke Franz Ferdinand of Austria on 28 June 1914 triggered the July Crisis. The alliance system drew the great powers into war. Militarism and imperial rivalry created the underlying conditions.';
export const SCENARIO_AFTERMATH =
  'The war led to the collapse of several empires and redrew the map of Europe.';
export const SCENARIO_RAW = `${SCENARIO_LEAD}\n\n${SCENARIO_CAUSES}\n\n${SCENARIO_AFTERMATH}`;

export const SCENARIO_SECTIONS: SectionIndexEntry[] = [
  { title: '', startOffset: 0, endOffset: SCENARIO_LEAD.length },
  {
    title: 'Causes',
    startOffset: SCENARIO_LEAD.length + 2,
    endOffset: SCENARIO_LEAD.length + 2 + SCENARIO_CAUSES.length,
  },
  {
    title: 'Aftermath',
    startOffset: SCENARIO_LEAD.length + 2 + SCENARIO_CAUSES.length + 2,
    endOffset: SCENARIO_RAW.length,
  },
];

export const DEFAULT_RESOLVER_MAP: Record<string, StubResolverEntry> = {
  'Assassination of Archduke Franz Ferdinand': { qid: 'Q83371', confidence: 'HIGH' },
  'European alliance system': { qid: 'Q1234', confidence: 'HIGH' },
  Militarism: { qid: 'Q999', confidence: 'HIGH' },
  'Collapse of empires': { qid: 'Q777', confidence: 'HIGH' },
};

/** Three upstream edges whose quotes all exist verbatim in SCENARIO_RAW. */
export function validUpstreamEdges() {
  return [
    proposedEdge({
      verbatimQuote:
        'The assassination of Archduke Franz Ferdinand of Austria on 28 June 1914 triggered the July Crisis.',
      relationType: 'TRIGGERED',
      importanceRank: 1,
      relatedEntity: {
        name: 'Assassination of Archduke Franz Ferdinand',
        dateStart: { year: 1914, month: 6, day: 28, precision: 'DAY' },
        dateEnd: { year: 1914, month: 6, day: 28, precision: 'DAY' },
      },
    }),
    proposedEdge({
      verbatimQuote: 'The alliance system drew the great powers into war.',
      relationType: 'ENABLED',
      importanceRank: 2,
      relatedEntity: {
        name: 'European alliance system',
        dateStart: { year: 1879, month: null, day: null, precision: 'YEAR' },
        dateEnd: { year: 1914, month: null, day: null, precision: 'YEAR' },
      },
    }),
    proposedEdge({
      verbatimQuote: 'Militarism and imperial rivalry created the underlying conditions.',
      relationType: 'CONTRIBUTED_TO',
      importanceRank: 3,
      relatedEntity: {
        name: 'Militarism',
        dateStart: { year: 1880, month: null, day: null, precision: 'YEAR' },
        dateEnd: { year: 1914, month: null, day: null, precision: 'YEAR' },
      },
    }),
  ];
}

/** A rich COMPLETED extraction output (3 valid edges). */
export function richOutput(): ExtractionOutput {
  return extractionOutput({ focalName: 'World War I', edges: validUpstreamEdges() });
}

/** A COMPLETED extraction with zero accepted edges (SPARSE). */
export function sparseOutput(): ExtractionOutput {
  return extractionOutput({ edges: [], sparsenessReason: 'No causal language found' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario seeding
// ─────────────────────────────────────────────────────────────────────────────

export interface FocalScenario {
  nodeId: string;
  sourceDocumentId: string;
  rawText: string;
  sectionIndex: SectionIndexEntry[];
}

export interface SeedFocalOptions {
  isRoot?: boolean;
  label?: string;
  wikipediaPageId?: number;
  rawText?: string;
  sectionIndex?: SectionIndexEntry[];
  upstreamState?: (typeof schema.expansionStateEnum.enumValues)[number];
  downstreamState?: (typeof schema.expansionStateEnum.enumValues)[number];
  wikidataQid?: string;
}

let pageCounter = 10_000;

/**
 * Insert a focal node plus a pinned SourceDocument that the stubbed
 * source-document service will return.
 */
export async function seedFocalScenario(
  db: Db,
  options: SeedFocalOptions = {},
): Promise<FocalScenario> {
  pageCounter += 1;
  const rawText = options.rawText ?? SCENARIO_RAW;
  const sectionIndex = options.sectionIndex ?? SCENARIO_SECTIONS;
  const wikipediaPageId = options.wikipediaPageId ?? pageCounter;

  const nodeId = await insertNode(db, {
    identityScheme: 'WIKIDATA',
    wikidataQid: options.wikidataQid ?? `Q${900000 + pageCounter}`,
    label: options.label ?? 'Focal entity',
    nodeType: 'EVENT',
    wikipediaPageId,
    isRoot: options.isRoot ?? true,
    ...(options.upstreamState ? { upstreamState: options.upstreamState } : {}),
    ...(options.downstreamState ? { downstreamState: options.downstreamState } : {}),
  });

  const [doc] = await db
    .insert(schema.sourceDocuments)
    .values({
      wikipediaPageId,
      wikipediaTitle: options.label ?? 'Focal entity',
      revisionId: 1000 + pageCounter,
      rawText,
      contentHash: `scenario-hash-${pageCounter}`,
      sectionIndex,
    })
    .returning({ id: schema.sourceDocuments.id });

  if (!doc) throw new Error('seedFocalScenario: source document insert failed');

  return { nodeId, sourceDocumentId: doc.id, rawText, sectionIndex };
}

export function buildFixtureConfig(
  scenario: Pick<FocalScenario, 'sourceDocumentId' | 'rawText' | 'sectionIndex'>,
  output: ExtractionOutput,
  resolverMap: Record<string, StubResolverEntry> = DEFAULT_RESOLVER_MAP,
): ExtractionConfig {
  const store = createLlmFixtureStore();
  registerWildcard(store, fixtureResponse(output));
  return {
    provider: store.buildProvider(),
    sourceDocumentService: createStubSourceDocumentService({
      id: scenario.sourceDocumentId,
      rawText: scenario.rawText,
      sectionIndex: scenario.sectionIndex,
      wikipediaPageId: 30030,
      wikipediaTitle: 'Scenario',
    }),
    resolver: createStubResolver(resolverMap),
    wikipedia: createUnusedWikipediaClient(),
    wikidata: createUnusedWikidataClient(),
  };
}

/** Like `buildFixtureConfig`, but the provider waits `delayMs` before returning. */
export function buildSlowFixtureConfig(
  scenario: Pick<FocalScenario, 'sourceDocumentId' | 'rawText' | 'sectionIndex'>,
  output: ExtractionOutput,
  delayMs: number,
): ExtractionConfig {
  const base = buildFixtureConfig(scenario, output);
  const inner = base.provider;
  return {
    ...base,
    provider: {
      providerId: inner.providerId,
      defaultModel: inner.defaultModel,
      async generate(input) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return inner.generate(input);
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Direct request insertion + claim/process helpers
// ─────────────────────────────────────────────────────────────────────────────

export interface InsertRequestInput {
  nodeId: string;
  direction: Direction;
  requestedBy?: string;
  status?: (typeof schema.expansionRequestStatusEnum.enumValues)[number];
  attempt?: number;
  maxAttempts?: number;
  lockedBy?: string | null;
  lockedAt?: Date | null;
  leaseExpiresAt?: Date | null;
  retryAfter?: Date | null;
  depthFromRoot?: number;
}

export async function insertExpansionRequest(
  db: Db,
  input: InsertRequestInput,
): Promise<string> {
  const [row] = await db
    .insert(schema.expansionRequests)
    .values({
      nodeId: input.nodeId,
      direction: input.direction,
      requestedBy: input.requestedBy ?? 'user-1',
      status: input.status ?? 'PENDING',
      attempt: input.attempt ?? 0,
      maxAttempts: input.maxAttempts ?? 3,
      lockedBy: input.lockedBy ?? null,
      lockedAt: input.lockedAt ?? null,
      leaseExpiresAt: input.leaseExpiresAt ?? null,
      retryAfter: input.retryAfter ?? null,
      depthFromRoot: input.depthFromRoot ?? 0,
    })
    .returning({ id: schema.expansionRequests.id });

  if (!row) throw new Error('insertExpansionRequest: insert failed');
  return row.id;
}

/** Claim and process exactly one request. Returns null when the queue is empty. */
export async function drainOne(
  db: Db,
  workerId: string,
  config: ExtractionConfig,
): Promise<{ claimed: ClaimedRequest; result: ProcessExpansionResult } | null> {
  const claimed = await claimNextRequest(db, { workerId });
  if (!claimed) return null;
  const result = await processExpansion(db, { claimed, config });
  return { claimed, result };
}

/** Poll until `predicate` is true, or throw after `timeoutMs`. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 20;
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: predicate did not become true before timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
