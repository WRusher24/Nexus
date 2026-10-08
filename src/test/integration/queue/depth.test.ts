import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { EdgeInsertInput } from '../../../lib/graph/types';
import {
  checkDepth,
  DEPTH_ORPHAN,
  MAX_DEPTH_FROM_ROOT,
} from '../../../lib/queue/depth';
import {
  closeTestDb,
  getTestDb,
  resetTestDb,
  type TestDb,
} from '../../helpers/db';
import {
  insertVerifiedEdgeThroughApp,
  makeEvidence,
} from '../../helpers/edgeHelper';
import {
  insertExtractionRun,
  insertNode,
  insertSourceDocument,
  uniqueQid,
} from '../../helpers/fixtures';

describe('queue/depth', () => {
  let testDb: TestDb;
  let sourceDocumentId: string;
  let extractionRunId: string;
  let year = 1900;

  beforeAll(async () => {
    testDb = await getTestDb();
  }, 60000);

  afterAll(async () => {
    await resetTestDb(testDb);
    await closeTestDb(testDb);
  });

  beforeEach(async () => {
    await resetTestDb(testDb);
    year = 1900;
    extractionRunId = '';
    const doc = await insertSourceDocument(testDb.db);
    sourceDocumentId = doc.id;
  });

  async function makeNode(isRoot = false): Promise<string> {
    year += 1;
    return insertNode(testDb.db, {
      identityScheme: 'WIKIDATA',
      wikidataQid: uniqueQid(),
      label: `Node ${year}`,
      nodeType: 'EVENT',
      dateStartYear: year,
      dateStartPrecision: 'YEAR',
      isRoot,
    });
  }

  async function addEdge(causeNodeId: string, effectNodeId: string): Promise<void> {
    const runId =
      extractionRunId ||
      (await insertExtractionRun(testDb.db, {
        focalNodeId: causeNodeId,
        sourceDocumentId,
      }));
    extractionRunId = runId;
    const input: EdgeInsertInput = {
      causeNodeId,
      effectNodeId,
      relationType: 'CAUSED',
      importanceRank: 5,
      contested: false,
      extractionRunId: runId,
      evidence: [makeEvidence({ sourceDocumentId, extractionRunId: runId })],
    };
    const result = await insertVerifiedEdgeThroughApp(testDb.db, input);
    if (result.outcome === 'REJECTED') {
      throw new Error(`fixture edge rejected: ${result.reason}`);
    }
  }

  it('reports a root node as depth 0 and within limit', async () => {
    const root = await makeNode(true);
    const result = await checkDepth(testDb.db, root);
    expect(result).toEqual({ depthFromRoot: 0, withinLimit: true });
  });

  it('reports a direct child of the root as depth 1', async () => {
    const root = await makeNode(true);
    const child = await makeNode();
    await addEdge(root, child);

    const result = await checkDepth(testDb.db, child);
    expect(result).toEqual({ depthFromRoot: 1, withinLimit: true });
  });

  it('allows a node exactly at MAX_DEPTH_FROM_ROOT', async () => {
    let current = await makeNode(true);
    for (let i = 0; i < MAX_DEPTH_FROM_ROOT; i += 1) {
      const next = await makeNode();
      await addEdge(current, next);
      current = next;
    }
    const result = await checkDepth(testDb.db, current);
    expect(result.depthFromRoot).toBe(MAX_DEPTH_FROM_ROOT);
    expect(result.withinLimit).toBe(true);
  });

  it('blocks a node one hop past the limit', async () => {
    let current = await makeNode(true);
    for (let i = 0; i < MAX_DEPTH_FROM_ROOT + 1; i += 1) {
      const next = await makeNode();
      await addEdge(current, next);
      current = next;
    }
    const result = await checkDepth(testDb.db, current);
    expect(result.depthFromRoot).toBe(MAX_DEPTH_FROM_ROOT + 1);
    expect(result.withinLimit).toBe(false);
  });

  it('blocks an orphan node with no reachable root', async () => {
    const orphan = await makeNode();
    const result = await checkDepth(testDb.db, orphan);
    expect(result).toEqual({ depthFromRoot: DEPTH_ORPHAN, withinLimit: false });
  });

  it('returns the shortest path in a diamond graph', async () => {
    const root = await makeNode(true);
    const a = await makeNode();
    const c = await makeNode();

    await addEdge(root, a); // root -> a
    await addEdge(a, c); // a -> c   (depth 2)
    await addEdge(root, c); // root -> c (depth 1)

    const result = await checkDepth(testDb.db, c);
    expect(result.depthFromRoot).toBe(1);
    expect(result.withinLimit).toBe(true);
  });
});
