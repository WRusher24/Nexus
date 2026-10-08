/**
 * requestExpansion — the public queue API (M7, Part 4).
 *
 * This is what M8's HTTP handler (and tests) call. It is idempotent and cheap
 * on repeat requests: an already-expanded node returns CACHE_HIT and consumes
 * no quota; an in-flight request joins and returns IN_PROGRESS. Only a fresh
 * (or previously FAILED) node reserves quota and enqueues work.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import { expansionRequests, extractionRuns, nodes } from '../db/schema';
import type { Database } from '../graph/types';
import type { Direction } from '../wikipedia/types';
import { checkDepth } from './depth';
import { isUniqueViolation, QueueError } from './errors';
import { ensureUserQuota, refundUserQuota, reserveUserQuota } from './quota';
import { setNodeState } from './transition';
import {
  IN_FLIGHT_STATUSES,
  type RequestExpansionInput,
  type RequestExpansionResult,
} from './types';

const VALID_DIRECTIONS: readonly Direction[] = ['UPSTREAM', 'DOWNSTREAM'];

/** Find the current in-flight request for a (node, direction), if any. */
async function findInFlight(
  db: Database,
  nodeId: string,
  direction: Direction,
): Promise<string | null> {
  const [row] = await db
    .select({ id: expansionRequests.id })
    .from(expansionRequests)
    .where(
      and(
        eq(expansionRequests.nodeId, nodeId),
        eq(expansionRequests.direction, direction),
        inArray(expansionRequests.status, [...IN_FLIGHT_STATUSES]),
      ),
    )
    .orderBy(desc(expansionRequests.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Public API: user clicked expand on a node.
 */
export async function requestExpansion(
  db: Database,
  input: RequestExpansionInput,
): Promise<RequestExpansionResult> {
  const { nodeId, direction, userId } = input;

  // ── 1. Validate input. ──
  if (!nodeId || !userId || userId.trim() === '') {
    return {
      outcome: 'REJECTED',
      reason: 'INVALID_INPUT',
      detail: 'nodeId and non-empty userId are required',
    };
  }
  if (!VALID_DIRECTIONS.includes(direction)) {
    return {
      outcome: 'REJECTED',
      reason: 'INVALID_INPUT',
      detail: `invalid direction "${String(direction)}"`,
    };
  }

  // ── 2. Read the node and its per-direction state. ──
  const [node] = await db
    .select({
      id: nodes.id,
      upstreamState: nodes.upstreamState,
      downstreamState: nodes.downstreamState,
    })
    .from(nodes)
    .where(eq(nodes.id, nodeId))
    .limit(1);

  if (!node) {
    return {
      outcome: 'REJECTED',
      reason: 'NODE_NOT_FOUND',
      detail: `node ${nodeId} does not exist`,
    };
  }

  const state = direction === 'UPSTREAM' ? node.upstreamState : node.downstreamState;

  // ── 3. Cache hit: already expanded (or known-sparse). No cost. ──
  if (state === 'EXPANDED' || state === 'SPARSE') {
    const [run] = await db
      .select({ id: extractionRuns.id })
      .from(extractionRuns)
      .where(
        and(
          eq(extractionRuns.focalNodeId, nodeId),
          eq(extractionRuns.direction, direction),
        ),
      )
      .orderBy(desc(extractionRuns.createdAt))
      .limit(1);
    return {
      outcome: 'CACHE_HIT',
      state,
      extractionRunId: run?.id ?? null,
    };
  }

  // ── 4. In progress: join the in-flight request. No cost. ──
  if (state === 'QUEUED' || state === 'LOADING') {
    const inflight = await findInFlight(db, nodeId, direction);
    if (inflight) {
      return { outcome: 'IN_PROGRESS', requestId: inflight };
    }
    // Inconsistent state (e.g. a request finished but the node was not
    // synced). Fall through and enqueue a fresh request.
  }

  // ── 5. UNEXPANDED or FAILED: build a new request. ──
  const depth = await checkDepth(db, nodeId);
  if (!depth.withinLimit) {
    return {
      outcome: 'REJECTED',
      reason: 'DEPTH_LIMIT_REACHED',
      detail: `node is at depth ${depth.depthFromRoot} (limit ${6})`,
    };
  }

  await ensureUserQuota(db, userId);
  const reservation = await reserveUserQuota(db, userId);
  if (!reservation) {
    return {
      outcome: 'REJECTED',
      reason: 'QUOTA_EXCEEDED',
      detail: `user ${userId} has exhausted their expansion quota`,
    };
  }

  try {
    const requestId = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(expansionRequests)
        .values({
          nodeId,
          direction,
          requestedBy: userId,
          status: 'PENDING',
          attempt: 0,
          depthFromRoot: depth.depthFromRoot,
        })
        .returning({ id: expansionRequests.id });

      if (!row) {
        throw new QueueError('INTERNAL', 'failed to create ExpansionRequest row');
      }

      await setNodeState(tx, nodeId, direction, 'QUEUED');
      return row.id;
    });

    return { outcome: 'QUEUED', requestId };
  } catch (error) {
    // The reservation did not buy a request: refund it.
    await refundUserQuota(db, reservation);

    if (isUniqueViolation(error)) {
      // Another process created an in-flight request between our read and
      // insert. Join it instead of erroring (idempotency).
      const inflight = await findInFlight(db, nodeId, direction);
      if (inflight) {
        return { outcome: 'IN_PROGRESS', requestId: inflight };
      }
    }

    return {
      outcome: 'REJECTED',
      reason: 'INVALID_INPUT',
      detail: `failed to enqueue expansion: ${String(error)}`,
    };
  }
}
