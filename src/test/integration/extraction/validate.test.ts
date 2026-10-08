import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { validateExtractionOutput, type ValidationContext } from '../../../lib/extraction/validate';
import { normalize } from '../../../lib/quote/normalize';
import {
  closeTestDb,
  getTestDb,
  resetTestDb,
  type TestDb,
} from '../../helpers/db';
import { insertNode } from '../../helpers/fixtures';
import {
  createStubResolver,
  extractionOutput,
  proposedEdge,
  type StubResolverEntry,
} from '../../fixtures/extraction/harness';

const LEAD =
  'World War I was a global conflict that lasted from 1914 to 1918. It reshaped the political order of Europe.';
const CAUSES =
  'The assassination of Archduke Franz Ferdinand of Austria on 28 June 1914 triggered the July Crisis. The alliance system drew the great powers into war. Militarism and imperial rivalry created the underlying conditions. A naval arms race heightened tensions. The Treaty of Versailles was signed in 1919.';
const AFTERMATH =
  'The war led to the collapse of several empires and redrew the map of Europe.';

const RAW_TEXT = `${LEAD}\n\n${CAUSES}\n\n${AFTERMATH}`;
const LEAD_END = LEAD.length;
const CAUSES_START = LEAD_END + 2;
const CAUSES_END = CAUSES_START + CAUSES.length;

const QUOTE_A =
  'The assassination of Archduke Franz Ferdinand of Austria on 28 June 1914 triggered the July Crisis.';
const QUOTE_B = 'The alliance system drew the great powers into war.';
const QUOTE_C = 'Militarism and imperial rivalry created the underlying conditions.';
const QUOTE_IRRELEVANT = 'A naval arms race heightened tensions.';
const QUOTE_CHRONO = 'The Treaty of Versailles was signed in 1919.';
const QUOTE_AFTERMATH =
  'The war led to the collapse of several empires and redrew the map of Europe.';
const QUOTE_SELF = 'World War I was a global conflict that lasted from 1914 to 1918.';

const RESOLVER_MAP: Record<string, StubResolverEntry> = {
  'Assassination of Archduke Franz Ferdinand': { qid: 'Q83371', confidence: 'HIGH' },
  'European alliance system': { qid: 'Q1234', confidence: 'HIGH' },
  Militarism: { qid: 'Q999', confidence: 'HIGH' },
  'Treaty of Versailles': { qid: 'Q8736', confidence: 'HIGH' },
  'Collapse of empires': { qid: 'Q777', confidence: 'HIGH' },
  'World War': { qid: 'Q361', confidence: 'HIGH' },
};

function baseContext(
  testDb: TestDb,
  overrides: Partial<ValidationContext> = {},
): ValidationContext {
  return {
    focalNodeId: '00000000-0000-0000-0000-000000000001',
    focalEntityName: 'World War I',
    focalQid: 'Q361',
    focalDates: {
      start: { year: 1914, month: 7, day: 28, precision: 'DAY' },
      end: { year: 1918, month: 11, day: 11, precision: 'DAY' },
    },
    direction: 'UPSTREAM',
    sourceDocumentId: '00000000-0000-0000-0000-0000000000aa',
    sourceRawText: RAW_TEXT,
    normalizedSource: normalize(RAW_TEXT),
    sentChunks: [
      { sectionTitle: '', startOffset: 0, endOffset: LEAD_END },
      { sectionTitle: 'Causes', startOffset: CAUSES_START, endOffset: CAUSES_END },
    ],
    resolver: createStubResolver(RESOLVER_MAP),
    db: testDb.db,
    ...overrides,
  };
}

type EdgeOverrides = Partial<Parameters<typeof proposedEdge>[0]>;

function edge(name: string, quote: string, overrides: EdgeOverrides = {}) {
  return proposedEdge({ verbatimQuote: quote, relatedEntity: { name }, ...overrides });
}

describe('validateExtractionOutput', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await getTestDb();
  }, 60000);

  afterAll(async () => {
    await resetTestDb(testDb);
    await closeTestDb(testDb);
  });

  beforeEach(async () => {
    await resetTestDb(testDb);
  });

  it('accepts three valid edges', async () => {
    const output = extractionOutput({
      edges: [
        edge('Assassination of Archduke Franz Ferdinand', QUOTE_A, { relationType: 'TRIGGERED' }),
        edge('European alliance system', QUOTE_B, { relationType: 'ENABLED' }),
        edge('Militarism', QUOTE_C, { relationType: 'CONTRIBUTED_TO' }),
      ],
    });
    const result = await validateExtractionOutput(output, baseContext(testDb));
    expect(result.accepted).toHaveLength(3);
    expect(result.rejected).toHaveLength(0);
  });

  it('rejects a quote that is not in the source', async () => {
    const output = extractionOutput({
      edges: [edge('Fabricated cause', 'This sentence does not appear anywhere in the article at all.', { relatedEntity: { name: 'Fabricated cause' } })],
    });
    const result = await validateExtractionOutput(output, baseContext(testDb));
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe('QUOTE_NOT_FOUND');
  });

  it('rejects a quote that exists only outside the sent chunks', async () => {
    const output = extractionOutput({
      edges: [edge('Collapse of empires', QUOTE_AFTERMATH)],
    });
    const result = await validateExtractionOutput(output, baseContext(testDb));
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe('QUOTE_OUTSIDE_SENT_CHUNKS');
  });

  it('rejects a quote that mentions neither endpoint entity', async () => {
    const output = extractionOutput({
      edges: [edge('Some Other Thing', QUOTE_IRRELEVANT)],
    });
    const result = await validateExtractionOutput(output, baseContext(testDb));
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe('QUOTE_IRRELEVANT');
  });

  it('rejects a chronologically impossible edge', async () => {
    const output = extractionOutput({
      edges: [
        edge('Treaty of Versailles', QUOTE_CHRONO, {
          relatedEntity: { name: 'Treaty of Versailles', dateStart: { year: 1919, month: null, day: null, precision: 'YEAR' } },
        }),
      ],
    });
    const result = await validateExtractionOutput(output, baseContext(testDb));
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe('CHRONOLOGY_VIOLATION');
  });

  it('accepts an edge with unknown dates and marks chronology UNVERIFIED', async () => {
    const output = extractionOutput({
      edges: [
        edge('European alliance system', QUOTE_B, {
          relatedEntity: {
            name: 'European alliance system',
            dateStart: { year: null, month: null, day: null, precision: 'UNKNOWN' },
            dateEnd: { year: null, month: null, day: null, precision: 'UNKNOWN' },
          },
        }),
      ],
    });
    const result = await validateExtractionOutput(output, baseContext(testDb));
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.chronologyStatus).toBe('UNVERIFIED');
  });

  it('rejects an edge that resolves to the focal entity (SELF_REFERENCE)', async () => {
    const output = extractionOutput({
      edges: [edge('World War', QUOTE_SELF)],
    });
    const result = await validateExtractionOutput(output, baseContext(testDb));
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe('SELF_REFERENCE');
  });

  it('rejects an edge whose related entity cannot be resolved at all', async () => {
    const output = extractionOutput({
      edges: [edge('Completely Unknown Entity', QUOTE_SELF)],
    });
    const result = await validateExtractionOutput(output, baseContext(testDb));
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe('RELATED_ENTITY_UNRESOLVABLE');
  });

  it('uses the WIKIDATA identity scheme for a HIGH-confidence QID', async () => {
    const output = extractionOutput({
      edges: [edge('Assassination of Archduke Franz Ferdinand', QUOTE_A)],
    });
    const result = await validateExtractionOutput(output, baseContext(testDb));
    expect(result.accepted[0]?.resolvedRelatedEntity.identityScheme).toBe('WIKIDATA');
    expect(result.accepted[0]?.resolvedRelatedEntity.qid).toBe('Q83371');
  });

  it('falls back to NEXUS_GENERATED for a LOW-confidence match', async () => {
    const output = extractionOutput({
      edges: [edge('Militarism', QUOTE_C)],
    });
    const context = baseContext(testDb, {
      resolver: createStubResolver({ Militarism: { qid: 'Q999', confidence: 'LOW' } }),
    });
    const result = await validateExtractionOutput(output, context);
    expect(result.accepted[0]?.resolvedRelatedEntity.identityScheme).toBe('NEXUS_GENERATED');
    expect(result.accepted[0]?.resolvedRelatedEntity.nexusGeneratedId).toMatch(/^nexus_[a-f0-9]{64}$/);
  });

  it('dedupes two edges with the same identity and relation, keeping the more important', async () => {
    const output = extractionOutput({
      edges: [
        edge('Militarism', QUOTE_C, { relationType: 'CONTRIBUTED_TO', importanceRank: 5 }),
        edge('Militarism', QUOTE_C, { relationType: 'CONTRIBUTED_TO', importanceRank: 2 }),
      ],
    });
    const result = await validateExtractionOutput(output, baseContext(testDb));
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.input.importanceRank).toBe(2);
    expect(result.rejected[0]?.reason).toBe('DUPLICATE_IN_BATCH');
  });

  it('references an existing node and its id', async () => {
    const existingNodeId = await insertNode(testDb.db, {
      identityScheme: 'WIKIDATA',
      wikidataQid: 'Q999',
      label: 'Militarism',
      nodeType: 'IDEOLOGY',
      dateStartYear: 1880,
      dateStartPrecision: 'YEAR',
    });

    const output = extractionOutput({
      edges: [edge('Militarism', QUOTE_C)],
    });
    const result = await validateExtractionOutput(output, baseContext(testDb));
    expect(result.accepted[0]?.resolvedRelatedEntity.existingNodeId).toBe(existingNodeId);
  });

  it('uses STORED dates for chronology when the node already exists', async () => {
    await insertNode(testDb.db, {
      identityScheme: 'WIKIDATA',
      wikidataQid: 'Q999',
      label: 'Militarism',
      nodeType: 'IDEOLOGY',
      dateStartYear: 2000,
      dateStartPrecision: 'YEAR',
    });

    const output = extractionOutput({
      edges: [
        edge('Militarism', QUOTE_C, {
          relatedEntity: {
            name: 'Militarism',
            dateStart: { year: 1880, month: null, day: null, precision: 'YEAR' },
          },
        }),
      ],
    });
    const result = await validateExtractionOutput(output, baseContext(testDb));
    // The LLM-restated 1880 would pass; the stored 2000 must cause a violation.
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe('CHRONOLOGY_VIOLATION');
  });

  it('records the actual section when the LLM claims the wrong one', async () => {
    const output = extractionOutput({
      edges: [edge('Militarism', QUOTE_C, { sectionTitle: 'Wrong Section' })],
    });
    const result = await validateExtractionOutput(output, baseContext(testDb));
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.evidence.sectionTitle).toBe('Causes');
  });

  it('passes through an empty edge list with the sparseness reason', async () => {
    const output = extractionOutput({
      edges: [],
      sparsenessReason: 'Article is a stub with no causal language.',
    });
    const result = await validateExtractionOutput(output, baseContext(testDb));
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
    expect(result.sparsenessReason).toBe('Article is a stub with no causal language.');
  });

  it('records normalized quote text and offsets for an accepted edge', async () => {
    const output = extractionOutput({
      edges: [edge('Militarism', QUOTE_C)],
    });
    const result = await validateExtractionOutput(output, baseContext(testDb));
    const accepted = result.accepted[0];
    expect(accepted?.evidence.charOffsetStart).toBeGreaterThanOrEqual(CAUSES_START);
    expect(accepted?.evidence.charOffsetEnd).toBeLessThanOrEqual(CAUSES_END);
    expect(accepted?.evidence.normalizedQuote).toBe(
      normalize(QUOTE_C).normalized,
    );
  });
});
