import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  edges,
  evidenceSpans,
  expansionRequests,
  nodes,
  qidReconciliations,
} from '../../../lib/db/schema';
import { mergeNodes } from '../../../lib/graph/mergeNodes';
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

describe('mergeNodes (P1 reconciliation / P2 safety)', () => {
  let testDb: TestDb;
  let fixtures: TestFixtures;

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
  });

  async function makeQidNode(label: string, year: number): Promise<string> {
    return insertNode(testDb.db, {
      identityScheme: 'WIKIDATA',
      wikidataQid: uniqueQid(),
      label,
      nodeType: 'EVENT',
      dateStartYear: year,
      dateStartPrecision: 'YEAR',
    });
  }

  async function makeGeneratedNode(label: string, year: number): Promise<string> {
    return insertNode(testDb.db, {
      identityScheme: 'NEXUS_GENERATED',
      nexusGeneratedId: `gen-${uniqueQid()}`,
      label,
      nodeType: 'EVENT',
      dateStartYear: year,
      dateStartPrecision: 'YEAR',
    });
  }

  function edgeInput(causeNodeId: string, effectNodeId: string): EdgeInsertInput {
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
      throw new Error(`fixture edge rejected: ${result.reason}`);
    }
  }

  it('repoints an edge from the removed node to the kept node and logs the merge', async () => {
    const x = await makeGeneratedNode('Generated X', 1900);
    const y = await makeQidNode('Resolved Y', 1920);
    const a = await makeQidNode('Node A', 1910);
    await addEdge(x, a);

    const result = await mergeNodes(testDb.db, {
      keepNodeId: y,
      removeNodeId: x,
      reason: 'QID resolved',
    });

    expect(result.outcome).toBe('MERGED');
    if (result.outcome !== 'MERGED') return;
    expect(result.edgesRepointed).toBe(1);
    expect(result.duplicateEdgesRemoved).toBe(0);

    const [edge] = await testDb.db
      .select()
      .from(edges)
      .where(and(eq(edges.causeNodeId, y), eq(edges.effectNodeId, a)));
    expect(edge).toBeDefined();

    const gone = await testDb.db.select().from(nodes).where(eq(nodes.id, x));
    expect(gone).toHaveLength(0);

    const logs = await testDb.db
      .select()
      .from(qidReconciliations)
      .where(eq(qidReconciliations.nodeId, x));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.mergedIntoNodeId).toBe(y);
  });

  it('retires a duplicate ACTIVE edge and moves its evidence to the survivor', async () => {
    const x = await makeGeneratedNode('Generated X', 1900);
    const y = await makeQidNode('Resolved Y', 1900);
    const a = await makeQidNode('Node A', 1910);

    // Y -> A first, so it is the earlier edge and must be the survivor.
    await addEdge(y, a);
    await addEdge(x, a);

    const result = await mergeNodes(testDb.db, {
      keepNodeId: y,
      removeNodeId: x,
      reason: 'duplicate',
    });

    expect(result.outcome).toBe('MERGED');
    if (result.outcome !== 'MERGED') return;
    expect(result.duplicateEdgesRemoved).toBe(1);

    const pairEdges = await testDb.db
      .select()
      .from(edges)
      .where(and(eq(edges.causeNodeId, y), eq(edges.effectNodeId, a)));
    expect(pairEdges).toHaveLength(2);
    const active = pairEdges.filter((e) => e.status === 'ACTIVE');
    const superseded = pairEdges.filter((e) => e.status === 'SUPERSEDED');
    expect(active).toHaveLength(1);
    expect(superseded).toHaveLength(1);

    const activeEdge = active[0];
    if (!activeEdge) throw new Error('expected one active edge');
    const spans = await testDb.db
      .select()
      .from(evidenceSpans)
      .where(eq(evidenceSpans.edgeId, activeEdge.id));
    expect(spans).toHaveLength(2);
  });

  it('removes an edge that would become a self-edge (CHECK forbids Y -> Y)', async () => {
    const x = await makeGeneratedNode('Generated X', 1900);
    const y = await makeQidNode('Resolved Y', 1920);
    await addEdge(x, y);

    const result = await mergeNodes(testDb.db, {
      keepNodeId: y,
      removeNodeId: x,
      reason: 'self-edge case',
    });

    expect(result.outcome).toBe('MERGED');
    // The only edge referenced X and would have become Y -> Y, which the
    // chk_no_self_edge CHECK forbids for every status, so it is removed.
    const remaining = await testDb.db.select().from(edges);
    expect(remaining).toHaveLength(0);

    const gone = await testDb.db.select().from(nodes).where(eq(nodes.id, x));
    expect(gone).toHaveLength(0);
  });

  it('fails when a node does not exist', async () => {
    const y = await makeQidNode('Resolved Y', 1920);
    const result = await mergeNodes(testDb.db, {
      keepNodeId: y,
      removeNodeId: randomUUID(),
      reason: 'missing',
    });
    expect(result.outcome).toBe('FAILED');
  });

  it('refuses a merge that would create a cycle and rolls back', async () => {
    const x = await makeGeneratedNode('Generated X', 1900);
    const a = await makeQidNode('Node A', 1910);
    const y = await makeQidNode('Resolved Y', 1920);

    await addEdge(x, a);
    await addEdge(a, y);

    const result = await mergeNodes(testDb.db, {
      keepNodeId: y,
      removeNodeId: x,
      reason: 'would cycle',
    });

    expect(result.outcome).toBe('FAILED');

    // Rolled back: X still exists and both original edges are intact.
    const stillThere = await testDb.db.select().from(nodes).where(eq(nodes.id, x));
    expect(stillThere).toHaveLength(1);
    const allEdges = await testDb.db.select().from(edges);
    expect(allEdges).toHaveLength(2);
    const [xEdge] = await testDb.db
      .select()
      .from(edges)
      .where(and(eq(edges.causeNodeId, x), eq(edges.effectNodeId, a)));
    expect(xEdge).toBeDefined();
  });

  it('deletes the removed node after a successful merge', async () => {
    const x = await makeGeneratedNode('Generated X', 1900);
    const y = await makeQidNode('Resolved Y', 1920);
    const a = await makeQidNode('Node A', 1910);
    await addEdge(x, a);

    await mergeNodes(testDb.db, {
      keepNodeId: y,
      removeNodeId: x,
      reason: 'cleanup',
    });

    const gone = await testDb.db.select().from(nodes).where(eq(nodes.id, x));
    expect(gone).toHaveLength(0);
  });

  it('repoints expansion requests that reference the removed node', async () => {
    const x = await makeGeneratedNode('Generated X', 1900);
    const y = await makeQidNode('Resolved Y', 1920);

    const [request] = await testDb.db
      .insert(expansionRequests)
      .values({
        nodeId: x,
        direction: 'UPSTREAM',
        requestedBy: 'test-user',
      })
      .returning({ id: expansionRequests.id });
    if (!request) throw new Error('expansion request insert failed');

    const result = await mergeNodes(testDb.db, {
      keepNodeId: y,
      removeNodeId: x,
      reason: 'repoint requests',
    });
    expect(result.outcome).toBe('MERGED');

    const [row] = await testDb.db
      .select()
      .from(expansionRequests)
      .where(eq(expansionRequests.id, request.id));
    expect(row?.nodeId).toBe(y);
  });

  it('reports accurate repoint and duplicate counts', async () => {
    const x = await makeGeneratedNode('Generated X', 1900);
    const y = await makeQidNode('Resolved Y', 1900);
    const a = await makeQidNode('Node A', 1910);
    const b = await makeQidNode('Node B', 1920);

    await addEdge(y, a); // survivor for the duplicate
    await addEdge(x, a); // duplicate
    await addEdge(x, b); // unique, just repointed

    const result = await mergeNodes(testDb.db, {
      keepNodeId: y,
      removeNodeId: x,
      reason: 'counts',
    });

    expect(result.outcome).toBe('MERGED');
    if (result.outcome !== 'MERGED') return;
    expect(result.edgesRepointed).toBe(2);
    expect(result.duplicateEdgesRemoved).toBe(1);
  });
});
