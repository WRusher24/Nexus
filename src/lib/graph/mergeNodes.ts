/**
 * Node merge / P1 reconciliation.
 *
 * When a NEXUS_GENERATED (or page-id) node is later resolved to a QID that an
 * existing node already owns, the two rows represent the same entity and must
 * collapse to one. Unlike `upsertNode`, which prevents duplicates up front,
 * this function repairs duplicates after the fact.
 *
 * The whole operation is one transaction: either the graph is consistent after
 * it, or nothing changed. If the merge would introduce a cycle (invariant P2)
 * the transaction is rolled back and the merge is reported FAILED.
 */

import { and, eq, inArray, ne, or } from 'drizzle-orm';
import {
  edgeFeedback,
  edges,
  evidenceSpans,
  expansionRequests,
  extractionRuns,
  nodes,
  qidReconciliations,
} from '../db/schema';
import { hasActiveCycle } from './cycleCheck';
import type { Database, MergeNodesInput, MergeNodesResult } from './types';

/** Internal sentinel: thrown to roll back a merge that would break P2. */
class MergeWouldCycleError extends Error {
  constructor() {
    super('merge would create a cycle');
    this.name = 'MergeWouldCycleError';
  }
}

/**
 * Merge `removeNodeId` into `keepNodeId`.
 *
 * Steps (single transaction):
 *   1. Lock both nodes FOR UPDATE; fail if either is missing.
 *   2. Repoint every edge that references the removed node.
 *      - A repointed ACTIVE edge whose target triple is already ACTIVE is
 *        superseded (and its evidence moved to the survivor), because the
 *        partial unique index forbids two ACTIVE edges on one triple.
 *      - A repointed edge that would become a self-edge cannot be stored (the
 *        `chk_no_self_edge` CHECK applies to all rows), so it is removed along
 *        with its evidence.
 *   3. Repoint expansion requests and extraction runs.
 *   4. Re-check the whole ACTIVE graph for cycles; abort if any.
 *   5. Log the reconciliation and delete the removed node.
 *
 * @param db - Drizzle database handle
 */
export async function mergeNodes(
  db: Database,
  input: MergeNodesInput,
): Promise<MergeNodesResult> {
  const { keepNodeId, removeNodeId } = input;

  if (keepNodeId === removeNodeId) {
    return {
      outcome: 'FAILED',
      reason: 'keepNodeId and removeNodeId must differ',
    };
  }

  try {
    return await db.transaction(async (tx) => {
      const locked = await tx
        .select()
        .from(nodes)
        .where(inArray(nodes.id, [keepNodeId, removeNodeId]))
        .for('update');

      const keep = locked.find((node) => node.id === keepNodeId);
      const remove = locked.find((node) => node.id === removeNodeId);

      if (!keep) {
        return { outcome: 'FAILED', reason: `keep node ${keepNodeId} not found` };
      }
      if (!remove) {
        return {
          outcome: 'FAILED',
          reason: `remove node ${removeNodeId} not found`,
        };
      }

      const referencing = await tx
        .select()
        .from(edges)
        .where(
          or(
            eq(edges.causeNodeId, removeNodeId),
            eq(edges.effectNodeId, removeNodeId),
          ),
        );

      let edgesRepointed = 0;
      let duplicateEdgesRemoved = 0;

      for (const edge of referencing) {
        const newCauseId =
          edge.causeNodeId === removeNodeId ? keepNodeId : edge.causeNodeId;
        const newEffectId =
          edge.effectNodeId === removeNodeId ? keepNodeId : edge.effectNodeId;

        if (newCauseId === newEffectId) {
          // Would violate chk_no_self_edge, which applies regardless of status.
          // Delete the edge and everything that references it: there is no way
          // to represent "a node caused itself" in this schema. (Documented
          // deviation from P4; forced by the CHECK constraint.)
          await tx
            .delete(edgeFeedback)
            .where(eq(edgeFeedback.edgeId, edge.id));
          await tx.delete(evidenceSpans).where(eq(evidenceSpans.edgeId, edge.id));
          await tx.delete(edges).where(eq(edges.id, edge.id));
          continue;
        }

        if (edge.status === 'ACTIVE') {
          const [conflict] = await tx
            .select({ id: edges.id, createdAt: edges.createdAt })
            .from(edges)
            .where(
              and(
                eq(edges.causeNodeId, newCauseId),
                eq(edges.effectNodeId, newEffectId),
                eq(edges.relationType, edge.relationType),
                eq(edges.status, 'ACTIVE'),
                ne(edges.id, edge.id),
              ),
            );

          if (conflict) {
            // Keep whichever edge was created first (per spec); move the
            // loser's evidence over, then retire the loser. A SUPERSEDED row
            // sits outside the partial unique index, so the repoint is legal.
            const keepReferencing = edge.createdAt < conflict.createdAt;
            const keptEdgeId = keepReferencing ? edge.id : conflict.id;
            const retiredEdgeId = keepReferencing ? conflict.id : edge.id;

            await tx
              .update(evidenceSpans)
              .set({ edgeId: keptEdgeId })
              .where(eq(evidenceSpans.edgeId, retiredEdgeId));

            if (keepReferencing) {
              // The referencing edge survives and takes over the target
              // triple; the previously-ACTIVE edge is retired in place.
              await tx
                .update(edges)
                .set({ status: 'SUPERSEDED', updatedAt: new Date() })
                .where(eq(edges.id, conflict.id));

              await tx
                .update(edges)
                .set({
                  causeNodeId: newCauseId,
                  effectNodeId: newEffectId,
                  updatedAt: new Date(),
                })
                .where(eq(edges.id, edge.id));
            } else {
              await tx
                .update(edges)
                .set({
                  status: 'SUPERSEDED',
                  causeNodeId: newCauseId,
                  effectNodeId: newEffectId,
                  updatedAt: new Date(),
                })
                .where(eq(edges.id, edge.id));
            }

            duplicateEdgesRemoved += 1;
            edgesRepointed += 1;
            continue;
          }
        }

        await tx
          .update(edges)
          .set({
            causeNodeId: newCauseId,
            effectNodeId: newEffectId,
            updatedAt: new Date(),
          })
          .where(eq(edges.id, edge.id));
        edgesRepointed += 1;
      }

      // Repoint every other FK that points at the removed node. `qidReconciliations`
      // has no FK (it is a log), so it does not block deletion.
      await tx
        .update(expansionRequests)
        .set({ nodeId: keepNodeId, updatedAt: new Date() })
        .where(eq(expansionRequests.nodeId, removeNodeId));

      await tx
        .update(extractionRuns)
        .set({ focalNodeId: keepNodeId, updatedAt: new Date() })
        .where(eq(extractionRuns.focalNodeId, removeNodeId));

      if (await hasActiveCycle(tx)) {
        throw new MergeWouldCycleError();
      }

      await tx.insert(qidReconciliations).values({
        nodeId: removeNodeId,
        previousScheme: remove.identityScheme,
        previousId: identityString(remove),
        resolvedQid: identityString(keep),
        mergedIntoNodeId: keepNodeId,
      });

      await tx.delete(nodes).where(eq(nodes.id, removeNodeId));

      return {
        outcome: 'MERGED',
        edgesRepointed,
        duplicateEdgesRemoved,
      };
    });
  } catch (error) {
    if (error instanceof MergeWouldCycleError) {
      return {
        outcome: 'FAILED',
        reason:
          'merge would create a cycle in the active edge graph (P2); rolled back',
      };
    }
    throw error;
  }
}

/** Best-effort string form of a node's canonical identity, for the log row. */
function identityString(node: typeof nodes.$inferSelect): string {
  if (node.wikidataQid) return node.wikidataQid;
  if (node.wikipediaPageId != null) return String(node.wikipediaPageId);
  if (node.nexusGeneratedId) return node.nexusGeneratedId;
  return '';
}
