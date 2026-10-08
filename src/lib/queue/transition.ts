/**
 * Expansion state machine (M7, Part 1).
 *
 * `transition()` is the single source of truth for state changes. It is the
 * only production code path that writes `expansionRequests.status` together
 * with `nodes.upstreamState` / `nodes.downstreamState` — the one other
 * sanctioned writer is `claim.ts`, which does the atomic LOCKED transition and
 * the node LOADING update inline for the `SKIP LOCKED` claim query.
 *
 * Concurrency: the UPDATE is guarded by `WHERE status = $fromStatus`, an
 * optimistic lock. If another process already moved the request, zero rows are
 * affected and the caller gets `STALE`. Both updates run in one transaction, so
 * either the request + node move together or neither does.
 */

import { and, eq } from 'drizzle-orm';
import { expansionRequests, nodes } from '../db/schema';
import type { Database, DbClient } from '../graph/types';
import type { Direction } from '../wikipedia/types';
import {
  type ExpansionRequestStatus,
  type NodeExpansionState,
} from './types';

export type { ExpansionRequestStatus, NodeExpansionState } from './types';

/**
 * Mapping from ExpansionRequest status → Node expansion state.
 * The node state is derived from the request status.
 */
export const REQUEST_TO_NODE_STATE: Record<
  ExpansionRequestStatus,
  NodeExpansionState
> = {
  PENDING: 'QUEUED',
  LOCKED: 'LOADING',
  FETCHING: 'LOADING',
  EXTRACTING: 'LOADING',
  VALIDATING: 'LOADING',
  COMPLETED: 'EXPANDED',
  FAILED: 'FAILED',
};

/**
 * Legal transitions. Rejects illegal state changes.
 * Format: { fromStatus: [allowed toStatuses] }
 *
 * `LOCKED → EXTRACTING` is added for the Option A phase policy chosen in M7
 * (the orchestrator's internal phases are not surfaced; we go straight from
 * LOCKED to EXTRACTING around the whole `runExtraction` call). `FETCHING` and
 * `VALIDATING` remain available for the Option B refinement.
 */
export const LEGAL_TRANSITIONS: Record<
  ExpansionRequestStatus,
  ExpansionRequestStatus[]
> = {
  PENDING: ['LOCKED', 'FAILED'],
  LOCKED: ['FETCHING', 'EXTRACTING', 'COMPLETED', 'PENDING', 'FAILED'], // PENDING via reaper
  FETCHING: ['EXTRACTING', 'PENDING', 'FAILED'],
  EXTRACTING: ['VALIDATING', 'COMPLETED', 'PENDING', 'FAILED'],
  VALIDATING: ['COMPLETED', 'PENDING', 'FAILED'],
  COMPLETED: [], // terminal
  FAILED: ['PENDING'], // only via manual retry (v2)
};

export interface TransitionPatch {
  lockedBy?: string | null;
  lockedAt?: Date | null;
  leaseExpiresAt?: Date | null;
  retryAfter?: Date | null;
  extractionRunId?: string | null;
  lastError?: string | null;
  failedAt?: Date | null;
  completedAt?: Date | null;
  attempt?: number;
}

export interface TransitionInput {
  requestId: string;
  fromStatus: ExpansionRequestStatus;
  toStatus: ExpansionRequestStatus;
  /**
   * Overrides for the derived node state. Used when:
   *   - COMPLETED → node state is SPARSE (not EXPANDED) because 0 edges.
   */
  nodeStateOverride?: NodeExpansionState;
  /** Patch applied to the ExpansionRequest row. */
  patch?: TransitionPatch;
}

export type TransitionResult =
  | {
      outcome: 'TRANSITIONED';
      newStatus: ExpansionRequestStatus;
      newNodeState: NodeExpansionState;
    }
  | { outcome: 'STALE'; reason: 'STATUS_CHANGED' | 'REQUEST_NOT_FOUND' }
  | { outcome: 'ILLEGAL'; reason: string };

/** Apply a node's per-direction expansion state. The only node-state writer
 * besides the inline update in `claim.ts`. */
export async function setNodeState(
  db: DbClient,
  nodeId: string,
  direction: Direction,
  state: NodeExpansionState,
): Promise<void> {
  const set =
    direction === 'UPSTREAM'
      ? { upstreamState: state, updatedAt: new Date() }
      : { downstreamState: state, updatedAt: new Date() };
  await db.update(nodes).set(set).where(eq(nodes.id, nodeId));
}

function buildPatch(patch: TransitionPatch | undefined): Partial<
  typeof expansionRequests.$inferInsert
> {
  const values: Partial<typeof expansionRequests.$inferInsert> = {};
  if (!patch) return values;
  if (patch.lockedBy !== undefined) values.lockedBy = patch.lockedBy;
  if (patch.lockedAt !== undefined) values.lockedAt = patch.lockedAt;
  if (patch.leaseExpiresAt !== undefined) values.leaseExpiresAt = patch.leaseExpiresAt;
  if (patch.retryAfter !== undefined) values.retryAfter = patch.retryAfter;
  if (patch.extractionRunId !== undefined) values.extractionRunId = patch.extractionRunId;
  if (patch.lastError !== undefined) values.lastError = patch.lastError;
  if (patch.failedAt !== undefined) values.failedAt = patch.failedAt;
  if (patch.completedAt !== undefined) values.completedAt = patch.completedAt;
  if (patch.attempt !== undefined) values.attempt = patch.attempt;
  return values;
}

/**
 * Atomically transition both the ExpansionRequest status AND the corresponding
 * Node.upstreamState / Node.downstreamState in a single transaction.
 *
 * Transition legality is enforced by LEGAL_TRANSITIONS *before* touching the
 * database. If the request is missing or its status is no longer `fromStatus`,
 * `STALE` is returned and nothing changes.
 */
export async function transition(
  db: Database,
  input: TransitionInput,
): Promise<TransitionResult> {
  const allowed = LEGAL_TRANSITIONS[input.fromStatus];
  if (!allowed || !allowed.includes(input.toStatus)) {
    return {
      outcome: 'ILLEGAL',
      reason: `illegal transition ${input.fromStatus} -> ${input.toStatus}`,
    };
  }

  const newNodeState =
    input.nodeStateOverride ?? REQUEST_TO_NODE_STATE[input.toStatus];

  const patched = buildPatch(input.patch);
  const setValues: Partial<typeof expansionRequests.$inferInsert> = {
    ...patched,
    status: input.toStatus,
    updatedAt: new Date(),
  };

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(expansionRequests)
      .set(setValues)
      .where(
        and(
          eq(expansionRequests.id, input.requestId),
          eq(expansionRequests.status, input.fromStatus),
        ),
      )
      .returning({
        nodeId: expansionRequests.nodeId,
        direction: expansionRequests.direction,
      });

    const row = updated[0];
    if (!row) {
      const [exists] = await tx
        .select({ id: expansionRequests.id })
        .from(expansionRequests)
        .where(eq(expansionRequests.id, input.requestId))
        .limit(1);
      return exists
        ? ({ outcome: 'STALE', reason: 'STATUS_CHANGED' } as const)
        : ({ outcome: 'STALE', reason: 'REQUEST_NOT_FOUND' } as const);
    }

    await setNodeState(tx, row.nodeId, row.direction, newNodeState);

    return {
      outcome: 'TRANSITIONED',
      newStatus: input.toStatus,
      newNodeState,
    } as const;
  });
}
