/**
 * Claim a pending request (M7, Part 5).
 *
 * The claim is the ONE place that increments `attempt`. `SELECT ... FOR UPDATE
 * SKIP LOCKED` grabs a row no sibling worker holds, and the same transaction
 * moves it to LOCKED, stamps the lease, and flips the owning node to LOADING.
 *
 * IMPORTANT: because this function increments `attempt`, the reaper MUST NOT
 * increment it again when it releases a stale lease (Amendment A8). See the
 * cross-reference in `reaper.ts`.
 */

import { eq, sql } from 'drizzle-orm';
import { nodes } from '../db/schema';
import type { Database } from '../graph/types';
import type { Direction } from '../wikipedia/types';

export const DEFAULT_CLAIM_LEASE_SECONDS = 90;

export interface ClaimedRequest {
  id: string;
  nodeId: string;
  direction: Direction;
  requestedBy: string;
  attempt: number;
  depthFromRoot: number;
  lockedBy: string;
  leaseExpiresAt: Date;
}

interface ClaimRow extends Record<string, unknown> {
  id: string;
  nodeId: string;
  direction: Direction;
  requestedBy: string;
  attempt: number;
  depthFromRoot: number;
  lockedBy: string;
  leaseExpiresAt: Date | string;
}

/** Normalise a timestamp value from the driver into a Date. */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export interface ClaimOptions {
  workerId: string;
  leaseSeconds?: number;
}

/**
 * Claim one pending request for processing, or return `null` when the queue is
 * empty (or every pending request is backing off via `retryAfter`).
 */
export async function claimNextRequest(
  db: Database,
  options: ClaimOptions,
): Promise<ClaimedRequest | null> {
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_CLAIM_LEASE_SECONDS;

  return db.transaction(async (tx) => {
    const result = await tx.execute<ClaimRow>(sql`
      UPDATE "expansionRequests"
      SET
        "status" = 'LOCKED',
        "lockedBy" = ${options.workerId},
        "lockedAt" = NOW(),
        "leaseExpiresAt" = NOW() + (${String(leaseSeconds)} || ' seconds')::interval,
        "attempt" = "attempt" + 1,
        "updatedAt" = NOW()
      WHERE "id" = (
        SELECT "id"
        FROM "expansionRequests"
        WHERE "status" = 'PENDING'
          AND ("retryAfter" IS NULL OR "retryAfter" <= NOW())
        ORDER BY "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING
        "id", "nodeId", "direction", "requestedBy", "attempt",
        "depthFromRoot", "lockedBy", "leaseExpiresAt"
    `);

    const row = result.rows[0];
    if (!row) return null;

    if (row.direction === 'UPSTREAM') {
      await tx
        .update(nodes)
        .set({ upstreamState: 'LOADING', updatedAt: new Date() })
        .where(eq(nodes.id, row.nodeId));
    } else {
      await tx
        .update(nodes)
        .set({ downstreamState: 'LOADING', updatedAt: new Date() })
        .where(eq(nodes.id, row.nodeId));
    }

    return {
      id: row.id,
      nodeId: row.nodeId,
      direction: row.direction,
      requestedBy: row.requestedBy,
      attempt: row.attempt,
      depthFromRoot: row.depthFromRoot,
      lockedBy: row.lockedBy,
      leaseExpiresAt: toDate(row.leaseExpiresAt),
    };
  });
}
