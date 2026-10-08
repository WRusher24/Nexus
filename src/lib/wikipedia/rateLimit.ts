/**
 * Simple in-process async rate limiter (Milestone 5).
 *
 * Wikipedia's published ceiling is 200 requests/second from a single
 * User-Agent, but polite practice is far below that. We cap at a configurable
 * rate (default 10 requests/second) to stay well under the limit.
 *
 * Implementation: a serial minimum-interval limiter. It tracks the timestamp
 * of the last request and, on `acquire()`, sleeps until at least
 * `1000 / requestsPerSecond` ms have elapsed. It deliberately does NOT allow
 * bursts (a true token bucket would); a steady trickle is the polite choice.
 *
 * Not thread-safe across processes. Each client/worker process owns its own
 * limiter. Aggregate load across our single worker and single Next.js process
 * stays well under the published limit.
 */

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface RateLimiterOptions {
  /** Maximum sustained requests per second. Must be > 0. */
  requestsPerSecond: number;
}

/**
 * A per-client serial rate limiter.
 *
 * The public surface is intentionally tiny and free of `private`/`#` fields
 * beyond construction inputs, so tests can spy on `acquire` with
 * `vi.spyOn(limiter, 'acquire')`.
 */
export class RateLimiter {
  private readonly minIntervalMs: number;
  private lastRequestAt = 0;

  constructor(options: RateLimiterOptions) {
    if (!Number.isFinite(options.requestsPerSecond) || options.requestsPerSecond <= 0) {
      throw new Error('RateLimiter: requestsPerSecond must be a positive number');
    }
    this.minIntervalMs = 1000 / options.requestsPerSecond;
  }

  /**
   * Blocks until a request slot is available. Resolves immediately when the
   * elapsed time since the previous request already exceeds the interval.
   */
  async acquire(): Promise<void> {
    const now = Date.now();
    const waitMs = this.minIntervalMs - (now - this.lastRequestAt);
    if (waitMs > 0) {
      await defaultSleep(waitMs);
    }
    this.lastRequestAt = Date.now();
  }
}
