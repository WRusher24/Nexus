/**
 * processExpansion — the worker's handler for one claimed request (M7, Part 8).
 *
 * Wraps M6's `runExtraction` with the state machine, quota refunds, retry
 * scheduling, and heartbeat management.
 *
 * Phase policy — Option A (from the brief): we do not surface the
 * orchestrator's internal phases. One transition enters EXTRACTING for the
 * whole `runExtraction` call, and one transition leaves it on completion,
 * retry, or failure. `FETCHING` and `VALIDATING` remain in the enum for the
 * Option B refinement.
 *
 * Budget vs. quota asymmetry (deliberate): quota is refunded on
 * ABORTED_BUDGET / ABORTED_NO_SOURCE (no LLM call was made; the user was not
 * served) but NOT on an LLM failure (real work was attempted and may have cost
 * money).
 */

import { eq } from 'drizzle-orm';
import { expansionRequests } from '../db/schema';
import { runExtraction } from '../extraction/orchestrator';
import type { ExtractionConfig, RunExtractionResult } from '../extraction/types';
import type { Database } from '../graph/types';
import type { ClaimedRequest } from './claim';
import { startHeartbeat } from './heartbeat';
import { refundUserQuota } from './quota';
import { BACKOFF_SECONDS, MAX_ATTEMPTS } from './reaper';
import { transition } from './transition';
import type { ExpansionRequestStatus } from './types';

export interface ProcessExpansionInput {
  claimed: ClaimedRequest;
  config: ExtractionConfig;
}

export type ProcessExpansionResult =
  | {
      outcome: 'COMPLETED';
      finalState: 'EXPANDED' | 'SPARSE';
      extractionRunId: string;
    }
  | {
      outcome: 'RETRY_SCHEDULED';
      retryAfter: Date;
    }
  | {
      outcome: 'FAILED';
      reason: string;
    };

const IN_FLIGHT: readonly ExpansionRequestStatus[] = [
  'LOCKED',
  'FETCHING',
  'EXTRACTING',
  'VALIDATING',
];

function backoffFor(attempt: number): number {
  return BACKOFF_SECONDS[attempt] ?? BACKOFF_SECONDS[1] ?? 30;
}

/**
 * Release a claimed request's lease after an unexpected error: schedule a
 * retry if attempts remain, otherwise fail it. Idempotent — if the request is
 * no longer in-flight this is a no-op. Exported so the run loop can use it as
 * a second safety net around `processExpansion`.
 */
export async function releaseLeaseAfterError(
  db: Database,
  claimed: ClaimedRequest,
): Promise<void> {
  const [row] = await db
    .select({ status: expansionRequests.status })
    .from(expansionRequests)
    .where(eq(expansionRequests.id, claimed.id))
    .limit(1);

  if (!row || !IN_FLIGHT.includes(row.status)) return;

  if (claimed.attempt < MAX_ATTEMPTS) {
    await transition(db, {
      requestId: claimed.id,
      fromStatus: row.status,
      toStatus: 'PENDING',
      patch: {
        lockedBy: null,
        lockedAt: null,
        leaseExpiresAt: null,
        retryAfter: new Date(Date.now() + backoffFor(claimed.attempt) * 1000),
        lastError: 'unexpected worker error',
      },
    });
  } else {
    await transition(db, {
      requestId: claimed.id,
      fromStatus: row.status,
      toStatus: 'FAILED',
      patch: {
        lockedBy: null,
        lockedAt: null,
        leaseExpiresAt: null,
        failedAt: new Date(),
        lastError: 'unexpected worker error after max attempts',
      },
    });
  }
}

export async function processExpansion(
  db: Database,
  input: ProcessExpansionInput,
): Promise<ProcessExpansionResult> {
  const { claimed, config } = input;

  // Option A: enter the processing phase directly from LOCKED.
  const entered = await transition(db, {
    requestId: claimed.id,
    fromStatus: 'LOCKED',
    toStatus: 'EXTRACTING',
  });
  if (entered.outcome !== 'TRANSITIONED') {
    return {
      outcome: 'FAILED',
      reason: `could not begin processing (${entered.outcome})`,
    };
  }

  const heartbeat = await startHeartbeat(db, {
    requestId: claimed.id,
    workerId: claimed.lockedBy,
  });

  try {
    let result: RunExtractionResult;
    try {
      result = await runExtraction(db, config, {
        focalNodeId: claimed.nodeId,
        direction: claimed.direction,
      });
    } catch (error) {
      // Unexpected (DB / programming) failure. Release the lease, then let the
      // run loop log it. The reaper is the final backstop if this also fails.
      await releaseLeaseAfterError(db, claimed);
      throw error;
    }

    switch (result.outcome) {
      case 'COMPLETED': {
        const done = await transition(db, {
          requestId: claimed.id,
          fromStatus: 'EXTRACTING',
          toStatus: 'COMPLETED',
          nodeStateOverride: result.finalState,
          patch: {
            extractionRunId: result.extractionRunId,
            completedAt: new Date(),
            lockedBy: null,
            lockedAt: null,
            leaseExpiresAt: null,
            lastError: null,
          },
        });
        if (done.outcome !== 'TRANSITIONED') {
          return { outcome: 'FAILED', reason: 'stale on completion' };
        }
        return {
          outcome: 'COMPLETED',
          finalState: result.finalState,
          extractionRunId: result.extractionRunId,
        };
      }

      case 'ABORTED_BUDGET':
      case 'ABORTED_NO_SOURCE': {
        const reason = `${result.outcome}: ${result.reason}`;
        await transition(db, {
          requestId: claimed.id,
          fromStatus: 'EXTRACTING',
          toStatus: 'FAILED',
          patch: {
            lastError: reason,
            failedAt: new Date(),
            lockedBy: null,
            lockedAt: null,
            leaseExpiresAt: null,
          },
        });
        // No LLM call was made: refund the user's quota charge.
        await refundUserQuota(db, {
          reservationId: claimed.id,
          userId: claimed.requestedBy,
        });
        return { outcome: 'FAILED', reason };
      }

      case 'FAILED': {
        const retryable = result.retryable && claimed.attempt < MAX_ATTEMPTS;
        if (retryable) {
          const retryAfter = new Date(
            Date.now() + backoffFor(claimed.attempt) * 1000,
          );
          const retried = await transition(db, {
            requestId: claimed.id,
            fromStatus: 'EXTRACTING',
            toStatus: 'PENDING',
            patch: {
              retryAfter,
              lastError: result.error,
              lockedBy: null,
              lockedAt: null,
              leaseExpiresAt: null,
            },
          });
          if (retried.outcome !== 'TRANSITIONED') {
            return { outcome: 'FAILED', reason: 'stale on retry' };
          }
          // Quota is NOT refunded: the LLM work was attempted.
          return { outcome: 'RETRY_SCHEDULED', retryAfter };
        }

        await transition(db, {
          requestId: claimed.id,
          fromStatus: 'EXTRACTING',
          toStatus: 'FAILED',
          patch: {
            lastError: result.error,
            failedAt: new Date(),
            lockedBy: null,
            lockedAt: null,
            leaseExpiresAt: null,
          },
        });
        return { outcome: 'FAILED', reason: result.error };
      }

      default: {
        // Exhaustive guard: every RunExtractionResult outcome is handled.
        const exhaustive: never = result;
        return { outcome: 'FAILED', reason: String(exhaustive) };
      }
    }
  } finally {
    await heartbeat.stop();
  }
}
