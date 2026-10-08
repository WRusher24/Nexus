import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import * as schema from '../../lib/db/schema';

type Db = NodePgDatabase<typeof schema>;

/** Columns callers may override when inserting a test node. */
export type InsertNodeInput = Partial<
  Omit<typeof schema.nodes.$inferInsert, 'id'>
>;

/**
 * Insert a node with sane defaults for the fields the CHECK constraints care
 * about. `identityScheme`, `label`, and `nodeType` default to valid values so
 * that callers only need to specify the identity fields under test.
 */
export async function insertNode(
  db: Db,
  overrides: InsertNodeInput = {},
): Promise<string> {
  const values = {
    identityScheme: 'WIKIDATA',
    label: 'Test node',
    nodeType: 'EVENT',
    ...overrides,
  } as typeof schema.nodes.$inferInsert;

  const [row] = await db
    .insert(schema.nodes)
    .values(values)
    .returning({ id: schema.nodes.id });

  if (!row) {
    throw new Error('insertNode: insert returned no row');
  }
  return row.id;
}

let qidCounter = 0;

/**
 * Generate a syntactically valid Wikidata QID (`^Q\d+$`) that is unique within
 * a test process. The graph write path validates the QID format, so tests that
 * exercise `upsertNode` must use this rather than the arbitrary labels used by
 * the low-level invariant fixtures.
 */
export function uniqueQid(): string {
  qidCounter += 1;
  return `Q${Date.now()}${qidCounter}`;
}

export interface SourceDocumentFixture {
  id: string;
  rawText: string;
  wikipediaPageId: number;
  revisionId: number;
}

/**
 * Insert a pinned source document. `rawText` can be overridden so evidence
 * offsets line up with the quote under test.
 */
export async function insertSourceDocument(
  db: Db,
  overrides: Partial<Omit<typeof schema.sourceDocuments.$inferInsert, 'id'>> = {},
): Promise<SourceDocumentFixture> {
  const suffix = randomUUID().slice(0, 8);
  const rawText =
    overrides.rawText ??
    'The source text that supports the test causal relationship.';

  const [row] = await db
    .insert(schema.sourceDocuments)
    .values({
      wikipediaPageId: Math.floor(Math.random() * 1_000_000_000),
      wikipediaTitle: 'Test article',
      revisionId: Math.floor(Math.random() * 1_000_000_000),
      rawText,
      contentHash: `hash-${suffix}`,
      sectionIndex: [
        { title: 'Lead', startOffset: 0, endOffset: rawText.length },
      ],
      ...overrides,
    })
    .returning({
      id: schema.sourceDocuments.id,
      rawText: schema.sourceDocuments.rawText,
      wikipediaPageId: schema.sourceDocuments.wikipediaPageId,
      revisionId: schema.sourceDocuments.revisionId,
    });

  if (!row) {
    throw new Error('insertSourceDocument: insert returned no row');
  }
  return {
    id: row.id,
    rawText: row.rawText,
    wikipediaPageId: row.wikipediaPageId,
    revisionId: row.revisionId,
  };
}

export interface InsertExtractionRunInput {
  focalNodeId: string;
  sourceDocumentId: string;
}

/**
 * Insert an extraction run focused on one node. Every edge references the run
 * that first proposed it (FK), so edges cannot be created without one.
 */
export async function insertExtractionRun(
  db: Db,
  input: InsertExtractionRunInput,
): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [row] = await db
    .insert(schema.extractionRuns)
    .values({
      focalNodeId: input.focalNodeId,
      direction: 'UPSTREAM',
      sourceDocumentId: input.sourceDocumentId,
      modelId: 'test-model-2024-01-01',
      promptVersion: '1.0.0',
      schemaVersion: '1.0.0',
      chunksUsed: [{ sectionTitle: 'Lead', startOffset: 0, endOffset: 100 }],
      rawPrompt: 'test prompt',
      rawResponse: 'test response',
      rawResponseHash: `response-hash-${suffix}`,
    })
    .returning({ id: schema.extractionRuns.id });

  if (!row) {
    throw new Error('insertExtractionRun: insert returned no row');
  }
  return row.id;
}

export interface TestFixtures {
  nodeA: string;
  nodeB: string;
  nodeC: string;
  nodeD: string;
  sourceDocumentId: string;
  extractionRunId: string;
}

/**
 * Create the minimal prerequisite records needed to insert edges: four nodes
 * with strictly increasing dates (A earliest, D latest), one pinned source
 * document, and one extraction run focused on `nodeA`.
 */
export async function createTestFixtures(db: Db): Promise<TestFixtures> {
  const suffix = randomUUID().slice(0, 8);

  const makeEvent = (label: string, year: number) =>
    insertNode(db, {
      identityScheme: 'WIKIDATA',
      wikidataQid: `Q${suffix}${label.replace(/\s+/g, '')}`,
      label,
      nodeType: 'EVENT',
      dateStartYear: year,
      dateStartPrecision: 'YEAR',
    });

  const nodeA = await makeEvent('Node A', 1900);
  const nodeB = await makeEvent('Node B', 1910);
  const nodeC = await makeEvent('Node C', 1920);
  const nodeD = await makeEvent('Node D', 1930);

  const rawText = 'The source text that supports the test causal relationship.';
  const [sourceDocument] = await db
    .insert(schema.sourceDocuments)
    .values({
      wikipediaPageId: Math.floor(Math.random() * 1_000_000_000),
      wikipediaTitle: 'Test article',
      revisionId: Math.floor(Math.random() * 1_000_000_000),
      rawText,
      contentHash: `hash-${suffix}`,
      sectionIndex: [{ title: 'Lead', startOffset: 0, endOffset: rawText.length }],
    })
    .returning({ id: schema.sourceDocuments.id });

  if (!sourceDocument) {
    throw new Error('createTestFixtures: source document insert returned no row');
  }

  const [extractionRun] = await db
    .insert(schema.extractionRuns)
    .values({
      focalNodeId: nodeA,
      direction: 'UPSTREAM',
      sourceDocumentId: sourceDocument.id,
      modelId: 'test-model-2024-01-01',
      promptVersion: '1.0.0',
      schemaVersion: '1.0.0',
      chunksUsed: [
        { sectionTitle: 'Lead', startOffset: 0, endOffset: rawText.length },
      ],
      rawPrompt: 'test prompt',
      rawResponse: 'test response',
      rawResponseHash: `response-hash-${suffix}`,
    })
    .returning({ id: schema.extractionRuns.id });

  if (!extractionRun) {
    throw new Error('createTestFixtures: extraction run insert returned no row');
  }

  return {
    nodeA,
    nodeB,
    nodeC,
    nodeD,
    sourceDocumentId: sourceDocument.id,
    extractionRunId: extractionRun.id,
  };
}
