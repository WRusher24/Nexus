/**
 * Feedback-driven auto-hide rule (M8, Part 4.8).
 *
 * v1 rule: an edge is hidden (status -> SUPERSEDED) when at least TWO distinct
 * users have submitted `INCORRECT` feedback for it. Hiding never deletes:
 * evidence and history survive for audit (invariant P4).
 *
 * This is the SECOND sanctioned writer of `edges.status` after
 * `insertVerifiedEdge.ts` (which writes it as part of the ACTIVE insert). The
 * state-write enforcement script's allowlist includes this file.
 */

import { sql } from 'drizzle-orm';
import type { DbClient } from '../graph/types';

/** Number of distinct INCORRECT reporters required before auto-hide. */
export const AUTO_HIDE_THRESHOLD = 2;

export interface AutoHideResult {
  hidden: boolean;
  reason: string | null;
}

/**
 * Check whether `edgeId` should be auto-hidden, and if so transition it from
 * ACTIVE to SUPERSEDED. Idempotent: an already-SUPERSEDED edge reports
 * `hidden: false`.
 */
export async function checkAutoHide(
  db: DbClient,
  edgeId: string,
): Promise<AutoHideResult> {
  const countResult = await db.execute<{ distinctUsers: number }>(sql`
    SELECT COUNT(DISTINCT "userId")::int AS "distinctUsers"
    FROM "edgeFeedback"
    WHERE "edgeId" = ${edgeId}::uuid
      AND "type" = 'INCORRECT'
  `);

  const distinctUsers = countResult.rows[0]?.distinctUsers ?? 0;
  if (distinctUsers < AUTO_HIDE_THRESHOLD) {
    return { hidden: false, reason: null };
  }

  const updated = await db.execute(sql`
    UPDATE "edges"
    SET "status" = 'SUPERSEDED', "updatedAt" = NOW()
    WHERE "id" = ${edgeId}::uuid
      AND "status" = 'ACTIVE'
    RETURNING "id"
  `);

  if (updated.rows.length === 0) {
    return { hidden: false, reason: 'edge is not ACTIVE' };
  }

  return {
    hidden: true,
    reason: `${distinctUsers} distinct users reported INCORRECT`,
  };
}
