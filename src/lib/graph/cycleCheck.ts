/**
 * Cycle detection for the ACTIVE causal graph (invariant P2).
 *
 * This is the application-level guard that runs inside the edge-insert
 * transaction. The DB-level audit (query 4) is the defence-in-depth backstop;
 * this function stops a cycle from ever being committed.
 *
 * Algorithm: walk UPSTREAM from `causeNodeId` (repeatedly find the causes of
 * the current node) and ask whether `effectNodeId` shows up among the
 * ancestors. If it does, adding cause -> effect closes a loop.
 */

import { sql } from 'drizzle-orm';
import type { CycleCheckResult, DbClient } from './types';

/**
 * Recursion bound. Mirrors the audit CTE and the depth limit; a graph deeper
 * than this is already malformed for our purposes, and the bound keeps a
 * corrupted (cyclic) dataset from spinning forever.
 */
const MAX_DEPTH = 50;

/**
 * Check whether adding an edge from `causeNodeId` -> `effectNodeId` would
 * create a cycle in the ACTIVE edge graph.
 *
 * MUST run inside the same transaction as the edge insert so the read and the
 * write share a snapshot (SERIALIZABLE). The caller owns the transaction
 * boundary; this function never opens one.
 *
 * @param tx - a Drizzle database or transaction handle
 */
export async function checkForCycle(
  tx: DbClient,
  causeNodeId: string,
  effectNodeId: string,
): Promise<CycleCheckResult> {
  // Fast path: a self-edge is always a cycle. The DB CHECK also rejects it,
  // but failing here avoids a pointless query.
  if (causeNodeId === effectNodeId) {
    return { wouldCreateCycle: true, cyclePath: [causeNodeId, effectNodeId] };
  }

  const result = await tx.execute<{
    wouldCreateCycle: boolean;
    cyclePath: string[] | null;
  }>(sql`
    WITH RECURSIVE ancestors AS (
      -- Base case: direct causes of the proposed cause node. The path is
      -- seeded with the proposed cause so the returned cycle path includes it.
      SELECT e."causeNodeId" AS "nodeId",
             ARRAY[${causeNodeId}::uuid, e."causeNodeId"] AS path,
             1 AS depth
      FROM "edges" e
      WHERE e."effectNodeId" = ${causeNodeId}::uuid
        AND e."status" = 'ACTIVE'

      UNION ALL

      -- Recursive step: walk further upstream.
      SELECT e."causeNodeId",
             a.path || e."causeNodeId",
             a.depth + 1
      FROM "edges" e
      JOIN ancestors a ON e."effectNodeId" = a."nodeId"
      WHERE e."status" = 'ACTIVE'
        AND a.depth < ${MAX_DEPTH}
        AND NOT (e."causeNodeId" = ANY(a.path))  -- prune existing-data loops
    )
    SELECT
      EXISTS (SELECT 1 FROM ancestors WHERE "nodeId" = ${effectNodeId}::uuid)
        AS "wouldCreateCycle",
      (
        SELECT path || ${effectNodeId}::uuid
        FROM ancestors
        WHERE "nodeId" = ${effectNodeId}::uuid
        LIMIT 1
      ) AS "cyclePath"
  `);

  const row = result.rows[0];
  const wouldCreateCycle = row?.wouldCreateCycle ?? false;

  if (!wouldCreateCycle) {
    return { wouldCreateCycle: false };
  }

  const rawPath = row?.cyclePath ?? [];
  return { wouldCreateCycle: true, cyclePath: dedupeConsecutive(rawPath) };
}

/** Collapse immediately repeated ids (the closing node is appended twice). */
function dedupeConsecutive(ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (out[out.length - 1] !== id) out.push(id);
  }
  return out;
}

/**
 * Detect whether the ACTIVE edge graph currently contains any cycle.
 *
 * Used by `mergeNodes` after repointing edges: a merge can, in rare cases,
 * weld two chains into a loop. This reuses the same shape as the invariant
 * audit's cycle query (query 4).
 */
export async function hasActiveCycle(tx: DbClient): Promise<boolean> {
  const result = await tx.execute<{ hasCycle: boolean }>(sql`
    WITH RECURSIVE chain AS (
      SELECT
        "causeNodeId" AS start,
        "effectNodeId" AS current,
        ARRAY["causeNodeId", "effectNodeId"] AS path,
        1 AS depth
      FROM "edges"
      WHERE "status" = 'ACTIVE'
      UNION ALL
      SELECT
        c.start,
        e."effectNodeId",
        c.path || e."effectNodeId",
        c.depth + 1
      FROM chain c
      JOIN "edges" e
        ON e."causeNodeId" = c.current
       AND e."status" = 'ACTIVE'
      WHERE c.depth < ${MAX_DEPTH}
        AND (
          e."effectNodeId" = c.start
          OR NOT (e."effectNodeId" = ANY(c.path))
        )
    )
    SELECT EXISTS (SELECT 1 FROM chain WHERE current = start) AS "hasCycle"
  `);

  return result.rows[0]?.hasCycle ?? false;
}
