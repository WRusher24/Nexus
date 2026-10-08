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

export interface TestFixtures {
  nodeA: string;
  nodeB: string;
  nodeC: string;
  sourceDocumentId: string;
  extractionRunId: string;
}

/**
 * Create the minimal prerequisite records needed to insert edges: three nodes
 * with QIDs, one pinned source document, and one extraction run focused on
 * `nodeA`. Returns the generated IDs.
 */
export async function createTestFixtures(db: Db): Promise<TestFixtures> {
  const suffix = randomUUID().slice(0, 8);

  const nodeA = await insertNode(db, {
    identityScheme: 'WIKIDATA',
    wikidataQid: `Q${suffix}A`,
    label: 'Node A',
    nodeType: 'EVENT',
    dateStartYear: 1900,
    dateStartPrecision: 'YEAR',
  });
  const nodeB = await insertNode(db, {
    identityScheme: 'WIKIDATA',
    wikidataQid: `Q${suffix}B`,
    label: 'Node B',
    nodeType: 'EVENT',
    dateStartYear: 1910,
    dateStartPrecision: 'YEAR',
  });
  const nodeC = await insertNode(db, {
    identityScheme: 'WIKIDATA',
    wikidataQid: `Q${suffix}C`,
    label: 'Node C',
    nodeType: 'PROCESS',
    dateStartYear: 1920,
    dateStartPrecision: 'YEAR',
  });

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
    sourceDocumentId: sourceDocument.id,
    extractionRunId: extractionRun.id,
  };
}
