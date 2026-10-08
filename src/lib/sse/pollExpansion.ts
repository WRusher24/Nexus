/**
 * Expansion status polling for SSE (M8, Part 4.7).
 *
 * The API polls `expansionRequests` (and the owning node's state) instead of
 * receiving push notifications from the worker. Polling keeps the MVP simple;
 * Postgres LISTEN/NOTIFY is a v2 optimisation.
 */

import { eq } from 'drizzle-orm';
import { expansionRequests, nodes } from '../db/schema';
import type { DbClient } from '../graph/types';
import type { Direction, ExpansionRequestStatus } from '../queue/types';

export interface ExpansionStatusSnapshot {
  requestId: string;
  nodeId: string;
  direction: Direction;
  status: ExpansionRequestStatus;
  attempt: number;
  extractionRunId: string | null;
  lastError: string | null;
  /** Node expansion state for the request's direction (EXPANDED / SPARSE / …). */
  finalState: string | null;
  updatedAt: Date;
}

/** Read the current status snapshot, or null when the request is gone. */
export async function fetchExpansionStatus(
  db: DbClient,
  requestId: string,
): Promise<ExpansionStatusSnapshot | null> {
  const [row] = await db
    .select({
      requestId: expansionRequests.id,
      nodeId: expansionRequests.nodeId,
      direction: expansionRequests.direction,
      status: expansionRequests.status,
      attempt: expansionRequests.attempt,
      extractionRunId: expansionRequests.extractionRunId,
      lastError: expansionRequests.lastError,
      updatedAt: expansionRequests.updatedAt,
      upstreamState: nodes.upstreamState,
      downstreamState: nodes.downstreamState,
    })
    .from(expansionRequests)
    .leftJoin(nodes, eq(nodes.id, expansionRequests.nodeId))
    .where(eq(expansionRequests.id, requestId))
    .limit(1);

  if (!row) return null;

  const finalState =
    row.direction === 'UPSTREAM' ? row.upstreamState : row.downstreamState;

  return {
    requestId: row.requestId,
    nodeId: row.nodeId,
    direction: row.direction,
    status: row.status,
    attempt: row.attempt,
    extractionRunId: row.extractionRunId,
    lastError: row.lastError,
    finalState: finalState ?? null,
    updatedAt: row.updatedAt,
  };
}

/** Terminal request statuses: the stream ends once one is observed. */
export function isTerminalStatus(status: ExpansionRequestStatus): boolean {
  return status === 'COMPLETED' || status === 'FAILED';
}
