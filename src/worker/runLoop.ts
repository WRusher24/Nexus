/**
 * Worker poll loop (M7, Part 9).
 *
 * One worker processes requests serially — one active request at a time. The
 * LLM is the bottleneck, so intra-worker concurrency would only complicate
 * error handling. Scale horizontally by running several worker containers; the
 * `SKIP LOCKED` claim keeps them from colliding.
 *
 * Two concurrent activities run here:
 *   1. The claim → process loop (this function's body).
 *   2. The reaper timer, which releases leases orphaned by crashed workers.
 *
 * Shutdown: when `signal` aborts, no new work is claimed; an in-flight request
 * is allowed to finish, then the loop returns. A hard process timeout is left
 * to the provider's own request timeout (and, ultimately, SIGKILL + the reaper)
 * rather than killing an in-flight LLM call and losing its result.
 */

import type { ExtractionConfig } from '../lib/extraction/types';
import type { Database } from '../lib/graph/types';
import { claimNextRequest } from '../lib/queue/claim';
import {
  processExpansion,
  releaseLeaseAfterError,
  type ProcessExpansionResult,
} from '../lib/queue/processExpansion';
import { runReaper } from '../lib/queue/reaper';

export interface RunLoopOptions {
  workerId: string;
  config: ExtractionConfig;
  /** Seconds to wait when the queue is empty before polling again. Default 2. */
  pollIntervalSeconds?: number;
  /** Seconds between reaper runs. Default 30. */
  reaperIntervalSeconds?: number;
  /** Abort signal to stop the loop gracefully. */
  signal: AbortSignal;
  /** Test/diagnostic hook: called after each processed request. */
  onProcessed?: (requestId: string, result: ProcessExpansionResult) => void;
  /** Test/diagnostic hook: called each time the queue is found empty. */
  onIdle?: () => void;
  /** Test/diagnostic hook: called for claim/process/reaper errors. */
  onError?: (error: unknown, stage: 'claim' | 'process' | 'reaper') => void;
}

const DEFAULT_POLL_INTERVAL_SECONDS = 2;
const DEFAULT_REAPER_INTERVAL_SECONDS = 30;

/** An abortable sleep: resolves early (never rejects) when the signal fires. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run the worker loop until `signal` is aborted. Resolves after the current
 * in-flight request (if any) finishes.
 */
export async function runWorkerLoop(
  db: Database,
  options: RunLoopOptions,
): Promise<void> {
  const pollMs =
    (options.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000;
  const reaperMs =
    (options.reaperIntervalSeconds ?? DEFAULT_REAPER_INTERVAL_SECONDS) * 1000;

  let reaperRunning = false;
  const reaperTimer = setInterval(() => {
    if (reaperRunning) return;
    reaperRunning = true;
    void runReaper(db)
      .catch((error: unknown) => options.onError?.(error, 'reaper'))
      .finally(() => {
        reaperRunning = false;
      });
  }, reaperMs);
  if (typeof reaperTimer.unref === 'function') reaperTimer.unref();

  try {
    while (!options.signal.aborted) {
      let claimed;
      try {
        claimed = await claimNextRequest(db, { workerId: options.workerId });
      } catch (error) {
        // Transient DB error: log and retry after the poll interval.
        options.onError?.(error, 'claim');
        await sleep(pollMs, options.signal);
        continue;
      }

      if (!claimed) {
        options.onIdle?.();
        await sleep(pollMs, options.signal);
        continue;
      }

      if (options.signal.aborted) {
        // Shutdown raced the claim: release so a sibling worker can take it.
        await releaseLeaseAfterError(db, claimed);
        break;
      }

      try {
        const result = await processExpansion(db, {
          claimed,
          config: options.config,
        });
        options.onProcessed?.(claimed.id, result);
      } catch (error) {
        options.onError?.(error, 'process');
        // processExpansion releases on its own; this is the safety net.
        try {
          await releaseLeaseAfterError(db, claimed);
        } catch (releaseError) {
          options.onError?.(releaseError, 'process');
        }
      }
    }
  } finally {
    clearInterval(reaperTimer);
  }
}
