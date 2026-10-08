/**
 * Server-side depth computation + enforcement (M7, Part 2; Amendment A10).
 *
 * Depth is the shortest upstream path from a node to any root (`isRoot = true`)
 * node. It is computed with `distanceToNearestRoot` and never accepted from the
 * client. `requestExpansion` calls this before reserving quota or budget.
 *
 * The depth check is a snapshot taken at request time. If the graph changes
 * afterwards, the queued request still processes at its original depth (a
 * deliberate choice documented in the milestone brief).
 */

import { distanceToNearestRoot } from '../graph/traversal';
import type { DbClient } from '../graph/types';

export interface DepthCheckResult {
  depthFromRoot: number;
  withinLimit: boolean;
}

export const MAX_DEPTH_FROM_ROOT = 6;

/** Sentinel used when no root is reachable (orphan subgraph → blocked). */
export const DEPTH_ORPHAN = 999;

/**
 * Compute a node's depth from the nearest root and enforce the limit.
 *
 * - `{ depthFromRoot: 0, withinLimit: true }` for a root itself.
 * - `{ depthFromRoot: N, withinLimit: N <= MAX_DEPTH_FROM_ROOT }` otherwise.
 * - `{ depthFromRoot: 999, withinLimit: false }` when no root is reachable.
 */
export async function checkDepth(
  db: DbClient,
  nodeId: string,
): Promise<DepthCheckResult> {
  const depth = await distanceToNearestRoot(db, nodeId);
  if (depth === null) {
    return { depthFromRoot: DEPTH_ORPHAN, withinLimit: false };
  }
  return { depthFromRoot: depth, withinLimit: depth <= MAX_DEPTH_FROM_ROOT };
}
