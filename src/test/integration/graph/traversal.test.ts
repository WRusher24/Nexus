import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  distanceToNearestRoot,
  getAncestors,
  getDescendants,
  getNodeNeighborhood,
} from '../../../lib/graph/traversal';
import type { EdgeInsertInput } from '../../../lib/graph/types';
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

/**
 * Graph under test:
 *
 *     A -> B -> D
 *     A -> C -> D
 *     C -> E
 *
 * A is the only root.
 */
describe('graph traversal (read paths)', () => {
  let testDb: TestDb;
  let nodeA: string;
  let nodeB: string;
  let nodeC: string;
  let nodeD: string;
  let nodeE: string;
  let sourceDocumentId: string;
  let extractionRunId: string;

  beforeAll(async () => {
    testDb = await getTestDb();
  }, 60000);

  afterAll(async () => {
    await resetTestDb(testDb);
    await closeTestDb(testDb);
  });

  async function makeNode(
    label: string,
    year: number,
    isRoot = false,
  ): Promise<string> {
    return insertNode(testDb.db, {
      identityScheme: 'WIKIDATA',
      wikidataQid: uniqueQid(),
      label,
      nodeType: 'EVENT',
      dateStartYear: year,
      dateStartPrecision: 'YEAR',
      isRoot,
    });
  }

  async function addEdge(causeNodeId: string, effectNodeId: string): Promise<void> {
    const input: EdgeInsertInput = {
      causeNodeId,
      effectNodeId,
      relationType: 'CAUSED',
      importanceRank: 5,
      contested: false,
      extractionRunId,
      evidence: [
        makeEvidence({ sourceDocumentId, extractionRunId }),
      ],
    };
    const result = await insertVerifiedEdgeThroughApp(testDb.db, input);
    if (result.outcome === 'REJECTED') {
      throw new Error(`fixture edge rejected: ${result.reason}`);
    }
  }

  beforeEach(async () => {
    await resetTestDb(testDb);
    nodeA = await makeNode('A', 1900, true);
    nodeB = await makeNode('B', 1910);
    nodeC = await makeNode('C', 1915);
    nodeD = await makeNode('D', 1920);
    nodeE = await makeNode('E', 1925);

    const source = await insertSourceDocument(testDb.db);
    sourceDocumentId = source.id;
    extractionRunId = await insertExtractionRun(testDb.db, {
      focalNodeId: nodeA,
      sourceDocumentId,
    });

    await addEdge(nodeA, nodeB);
    await addEdge(nodeA, nodeC);
    await addEdge(nodeB, nodeD);
    await addEdge(nodeC, nodeD);
    await addEdge(nodeC, nodeE);
  });

  it('getNodeNeighborhood(B) returns cause A and effect D', async () => {
    const result = await getNodeNeighborhood(testDb.db, nodeB);
    expect(result).not.toBeNull();
    expect(result?.causes.map((c) => c.node.id)).toEqual([nodeA]);
    expect(result?.effects.map((e) => e.node.id)).toEqual([nodeD]);
  });

  it('getNodeNeighborhood(D) returns causes B and C, no effects', async () => {
    const result = await getNodeNeighborhood(testDb.db, nodeD);
    const causeIds = (result?.causes ?? []).map((c) => c.node.id).sort();
    expect(causeIds).toEqual([nodeB, nodeC].sort());
    expect(result?.effects).toHaveLength(0);
  });

  it('getNodeNeighborhood(A) returns no causes and effects B and C', async () => {
    const result = await getNodeNeighborhood(testDb.db, nodeA);
    expect(result?.causes).toHaveLength(0);
    const effectIds = (result?.effects ?? []).map((e) => e.node.id).sort();
    expect(effectIds).toEqual([nodeB, nodeC].sort());
  });

  it('getNodeNeighborhood returns null for a non-existent node', async () => {
    const result = await getNodeNeighborhood(testDb.db, randomUUID());
    expect(result).toBeNull();
  });

  it('getAncestors(D, 1) returns immediate parents B and C', async () => {
    const result = await getAncestors(testDb.db, nodeD, 1);
    expect(result.nodes.map((n) => n.id).sort()).toEqual([nodeB, nodeC].sort());
    expect(result.edges).toHaveLength(2);
  });

  it('getAncestors(D, 2) returns A, B, and C with four edges', async () => {
    const result = await getAncestors(testDb.db, nodeD, 2);
    expect(result.nodes.map((n) => n.id).sort()).toEqual(
      [nodeA, nodeB, nodeC].sort(),
    );
    expect(result.edges).toHaveLength(4);
  });

  it('getAncestors deduplicates A across two paths', async () => {
    const result = await getAncestors(testDb.db, nodeD, 2);
    const aCount = result.nodes.filter((n) => n.id === nodeA).length;
    expect(aCount).toBe(1);
  });

  it('getDescendants(A, 2) returns B, C, D, E and all five edges', async () => {
    const result = await getDescendants(testDb.db, nodeA, 2);
    expect(result.nodes.map((n) => n.id).sort()).toEqual(
      [nodeB, nodeC, nodeD, nodeE].sort(),
    );
    expect(result.edges).toHaveLength(5);
  });

  it('distanceToNearestRoot(A) is 0 for a root node', async () => {
    expect(await distanceToNearestRoot(testDb.db, nodeA)).toBe(0);
  });

  it('distanceToNearestRoot(D) is 2', async () => {
    expect(await distanceToNearestRoot(testDb.db, nodeD)).toBe(2);
  });

  it('distanceToNearestRoot(E) is 2', async () => {
    expect(await distanceToNearestRoot(testDb.db, nodeE)).toBe(2);
  });

  it('distanceToNearestRoot returns null for an isolated node', async () => {
    const f = await makeNode('F', 2000);
    expect(await distanceToNearestRoot(testDb.db, f)).toBeNull();
  });
});
