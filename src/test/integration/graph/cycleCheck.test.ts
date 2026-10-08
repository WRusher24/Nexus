import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkForCycle } from '../../../lib/graph/cycleCheck';
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
  createTestFixtures,
  insertNode,
  uniqueQid,
  type TestFixtures,
} from '../../helpers/fixtures';

describe('checkForCycle (P2 acyclicity)', () => {
  let testDb: TestDb;
  let fixtures: TestFixtures;
  let nodeE: string;

  beforeAll(async () => {
    testDb = await getTestDb();
  }, 60000);

  afterAll(async () => {
    await resetTestDb(testDb);
    await closeTestDb(testDb);
  });

  beforeEach(async () => {
    await resetTestDb(testDb);
    fixtures = await createTestFixtures(testDb.db);
    nodeE = await insertNode(testDb.db, {
      identityScheme: 'WIKIDATA',
      wikidataQid: uniqueQid(),
      label: 'Node E',
      nodeType: 'EVENT',
      dateStartYear: 1940,
      dateStartPrecision: 'YEAR',
    });
  });

  function edgeInput(
    causeNodeId: string,
    effectNodeId: string,
  ): EdgeInsertInput {
    return {
      causeNodeId,
      effectNodeId,
      relationType: 'CAUSED',
      importanceRank: 5,
      contested: false,
      extractionRunId: fixtures.extractionRunId,
      evidence: [
        makeEvidence({
          sourceDocumentId: fixtures.sourceDocumentId,
          extractionRunId: fixtures.extractionRunId,
        }),
      ],
    };
  }

  async function addEdge(causeNodeId: string, effectNodeId: string): Promise<void> {
    const result = await insertVerifiedEdgeThroughApp(
      testDb.db,
      edgeInput(causeNodeId, effectNodeId),
    );
    if (result.outcome === 'REJECTED') {
      throw new Error(
        `fixture edge rejected: ${result.reason} (${result.detail})`,
      );
    }
  }

  it('reports no cycle on an empty graph', async () => {
    const result = await checkForCycle(testDb.db, fixtures.nodeA, fixtures.nodeB);
    expect(result.wouldCreateCycle).toBe(false);
    expect(result.cyclePath).toBeUndefined();
  });

  it('detects a two-node cycle (A -> B, propose B -> A)', async () => {
    await addEdge(fixtures.nodeA, fixtures.nodeB);

    const result = await checkForCycle(testDb.db, fixtures.nodeB, fixtures.nodeA);
    expect(result.wouldCreateCycle).toBe(true);
    expect(result.cyclePath).toEqual(
      expect.arrayContaining([fixtures.nodeA, fixtures.nodeB]),
    );
  });

  it('detects a three-node cycle (A -> B -> C, propose C -> A)', async () => {
    await addEdge(fixtures.nodeA, fixtures.nodeB);
    await addEdge(fixtures.nodeB, fixtures.nodeC);

    const result = await checkForCycle(testDb.db, fixtures.nodeC, fixtures.nodeA);
    expect(result.wouldCreateCycle).toBe(true);
    expect(result.cyclePath).toEqual(
      expect.arrayContaining([fixtures.nodeA, fixtures.nodeB, fixtures.nodeC]),
    );
  });

  it('detects a cycle through a branch (A -> B, A -> C, C -> D, propose D -> A)', async () => {
    await addEdge(fixtures.nodeA, fixtures.nodeB);
    await addEdge(fixtures.nodeA, fixtures.nodeC);
    await addEdge(fixtures.nodeC, fixtures.nodeD);

    const result = await checkForCycle(testDb.db, fixtures.nodeD, fixtures.nodeA);
    expect(result.wouldCreateCycle).toBe(true);
    expect(result.cyclePath).toEqual(
      expect.arrayContaining([fixtures.nodeA, fixtures.nodeC, fixtures.nodeD]),
    );
  });

  it('reports no cycle when the proposed edge joins two separate chains', async () => {
    await addEdge(fixtures.nodeA, fixtures.nodeB);
    await addEdge(fixtures.nodeC, fixtures.nodeD);

    // C -> D -> A -> B is acyclic; nothing reaches D from A.
    const result = await checkForCycle(testDb.db, fixtures.nodeD, fixtures.nodeA);
    expect(result.wouldCreateCycle).toBe(false);
  });

  it('catches a self-edge before running the CTE', async () => {
    const result = await checkForCycle(
      testDb.db,
      fixtures.nodeA,
      fixtures.nodeA,
    );
    expect(result.wouldCreateCycle).toBe(true);
    expect(result.cyclePath).toEqual([fixtures.nodeA, fixtures.nodeA]);
  });

  it('detects a cycle across a long chain (A->B->C->D->E, propose E->A)', async () => {
    await addEdge(fixtures.nodeA, fixtures.nodeB);
    await addEdge(fixtures.nodeB, fixtures.nodeC);
    await addEdge(fixtures.nodeC, fixtures.nodeD);
    await addEdge(fixtures.nodeD, nodeE);

    const result = await checkForCycle(testDb.db, nodeE, fixtures.nodeA);
    expect(result.wouldCreateCycle).toBe(true);
    expect(result.cyclePath?.length).toBeGreaterThanOrEqual(5);
  });

  it('detects a cycle in a diamond (A->B, A->C, B->D, C->D, propose D->A)', async () => {
    await addEdge(fixtures.nodeA, fixtures.nodeB);
    await addEdge(fixtures.nodeA, fixtures.nodeC);
    await addEdge(fixtures.nodeB, fixtures.nodeD);
    await addEdge(fixtures.nodeC, fixtures.nodeD);

    const result = await checkForCycle(testDb.db, fixtures.nodeD, fixtures.nodeA);
    expect(result.wouldCreateCycle).toBe(true);
    expect(result.cyclePath).toEqual(
      expect.arrayContaining([fixtures.nodeA, fixtures.nodeD]),
    );
  });
});
