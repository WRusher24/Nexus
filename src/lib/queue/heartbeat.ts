/**
 * Lease heartbeat (M7, Part 6; Amendment A8).
 *
 * A worker extends its lease every `intervalSeconds` so the reaper does not
 * reclaim a request while a long LLM call is still running. The update is
 * scoped to `lockedBy = workerId` and an in-flight status; if it affects zero
 * rows the worker has lost the lease (another worker reclaimed it), and the
 * heartbeat stops itself and reports `lostLease`.
 *
 * Transient database errors are logged and do NOT stop the heartbeat: a single
 * failed tick should not orphan the request. `stop()` must always be called
 * before the worker returns.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../graph/types';

export interface HeartbeatHandle {
  /** Stop sending heartbeats. */
  stop(): Promise<void>;
  /** True once a tick found the lease owned elsewhere / transitioned away. */
  readonly lostLease: boolean;
  /** Last transient error seen by a tick, if any. */
  readonly lastError: unknown;
}

export interface HeartbeatOptions {
  requestId: string;
  workerId: string;
  /** Seconds between ticks. Default 30. */
  intervalSeconds?: number;
  /** Seconds each tick extends the lease by. Default 90. */
  leaseSeconds?: number;
}

export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 30;
export const DEFAULT_LEASE_SECONDS = 90;

export async function startHeartbeat(
  db: Database,
  options: HeartbeatOptions,
): Promise<HeartbeatHandle> {
  const { requestId, workerId } = options;
  const intervalSeconds =
    options.intervalSeconds ?? DEFAULT_HEARTBEAT_INTERVAL_SECONDS;
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;

  let stopped = false;
  let lostLease = false;
  let lastError: unknown;
  let timer: ReturnType<typeof setInterval> | undefined;

  function stopInternal(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    stopped = true;
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const result = await db.execute<{ id: string }>(sql`
        UPDATE "expansionRequests"
        SET
          "leaseExpiresAt" = NOW() + (${String(leaseSeconds)} || ' seconds')::interval,
          "updatedAt" = NOW()
        WHERE "id" = ${requestId}::uuid
          AND "lockedBy" = ${workerId}
          AND "status" IN ('LOCKED', 'FETCHING', 'EXTRACTING', 'VALIDATING')
        RETURNING "id"
      `);
      if (result.rows.length === 0) {
        lostLease = true;
        console.warn(
          `[heartbeat] lost lease for request ${requestId} (worker ${workerId}) — another worker may have reclaimed it`,
        );
        stopInternal();
      }
    } catch (error) {
      // Transient failure: keep ticking. A later tick (or the reaper) resolves.
      lastError = error;
      console.warn(
        `[heartbeat] tick failed for request ${requestId} (worker ${workerId}): ${String(error)}`,
      );
    }
  }

  timer = setInterval(() => {
    void tick();
  }, intervalSeconds * 1000);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    async stop(): Promise<void> {
      stopInternal();
    },
    get lostLease(): boolean {
      return lostLease;
    },
    get lastError(): unknown {
      return lastError;
    },
  };
}
