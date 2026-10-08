/**
 * Lease reaper (M7, Part 7; Amendment A8).
 *
 * Finds in-flight requests whose `leaseExpiresAt` has passed (the worker
 * crashed, the container was killed, or the heartbeat failed) and returns them
 * to the queue. Release is done through `transition()`, so the request status
 * and the node state move together.
 *
 * CRITICAL: the reaper does NOT increment `attempt`. The attempt counter is
 * incremented exactly once, by `claim.ts` when the request is claimed. If the
 * reaper incremented it too, every crash would burn two attempts and retries
 * would exhaust early. See the cross-reference in `claim.ts`.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../graph/types';
import { transition } from './transition';
import type { ExpansionRequestStatus } from './types';

/** Backoff schedule based on the attempt count *already* consumed. */
export const BACKOFF_SECONDS: Record<number, number> = {
  1: 30,
  2: 120,
  3: 0, // no more retries
};

export const MAX_ATTEMPTS = 3;

export interface ReaperResult {
  reclaimedToPending: number;
  movedToFailed: number;
}

interface StaleRow extends Record<string, unknown> {
  id: string;
  nodeId: string;
  direction: 'UPSTREAM' | 'DOWNSTREAM';
  status: ExpansionRequestStatus;
  attempt: number;
}

/**
 * Release every stale lease. Safe to run concurrently from multiple workers:
 * `transition`'s optimistic `WHERE status = $fromStatus` guarantees only one
 * release per request.
 */
export async function runReaper(db: Database): Promise<ReaperResult> {
  const stale = await db.execute<StaleRow>(sql`
    SELECT "id", "nodeId", "direction", "status", "attempt"
    FROM "expansionRequests"
    WHERE "leaseExpiresAt" IS NOT NULL
      AND "leaseExpiresAt" < NOW()
      AND "status" IN ('LOCKED', 'FETCHING', 'EXTRACTING', 'VALIDATING')
  `);

  let reclaimedToPending = 0;
  let movedToFailed = 0;

  for (const row of stale.rows) {
    if (row.attempt < MAX_ATTEMPTS) {
      const backoff = BACKOFF_SECONDS[row.attempt] ?? BACKOFF_SECONDS[1] ?? 30;
      const result = await transition(db, {
        requestId: row.id,
        fromStatus: row.status,
        toStatus: 'PENDING',
        patch: {
          lockedBy: null,
          lockedAt: null,
          leaseExpiresAt: null,
          retryAfter: new Date(Date.now() + backoff * 1000),
          lastError: `reaper: lease expired (attempt ${row.attempt})`,
        },
      });
      if (result.outcome === 'TRANSITIONED') reclaimedToPending += 1;
    } else {
      const result = await transition(db, {
        requestId: row.id,
        fromStatus: row.status,
        toStatus: 'FAILED',
        patch: {
          lockedBy: null,
          lockedAt: null,
          leaseExpiresAt: null,
          failedAt: new Date(),
          lastError: `reaper: lease expired after ${row.attempt} attempts`,
        },
      });
      if (result.outcome === 'TRANSITIONED') movedToFailed += 1;
    }
  }

  return { reclaimedToPending, movedToFailed };
}
