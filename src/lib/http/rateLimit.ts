/**
 * In-memory token-bucket rate limiter (M8, Part 3.4).
 *
 * Keyed by `userId + bucket`. Not shared across API processes: for the
 * single-process MVP this is adequate; sustained-cost protection comes from
 * the DB-backed per-user quota and the global budget (P6). v2 can move this to
 * Redis.
 *
 * Buckets (tokens / minute):
 *   search    20
 *   expansion 10
 *   default   60
 */

interface BucketConfig {
  capacity: number;
  /** Tokens added per millisecond. */
  refillPerMs: number;
}

function perMinute(capacity: number): BucketConfig {
  return { capacity, refillPerMs: capacity / 60_000 };
}

const DEFAULT_BUCKET = perMinute(60);

const BUCKETS: Record<string, BucketConfig> = {
  search: perMinute(20),
  expansion: perMinute(10),
  default: DEFAULT_BUCKET,
};

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

const store = new Map<string, BucketState>();

function configFor(bucket: string): BucketConfig {
  return BUCKETS[bucket] ?? DEFAULT_BUCKET;
}

function keyFor(userId: string, bucket: string): string {
  return `${userId}::${bucket}`;
}

/**
 * Consume one token from `bucket` for `userId`.
 * Returns true when allowed, false when rate limited.
 */
export function checkRateLimit(userId: string, bucket: string): boolean {
  const config = configFor(bucket);
  const key = keyFor(userId, bucket);
  const now = Date.now();

  let state = store.get(key);
  if (!state) {
    state = { tokens: config.capacity, lastRefillMs: now };
    store.set(key, state);
  }

  const elapsed = now - state.lastRefillMs;
  state.tokens = Math.min(
    config.capacity,
    state.tokens + elapsed * config.refillPerMs,
  );
  state.lastRefillMs = now;

  if (state.tokens < 1) return false;
  state.tokens -= 1;
  return true;
}

/** Seconds until the next token is available (for the Retry-After header). */
export function retryAfterSeconds(userId: string, bucket: string): number {
  const config = configFor(bucket);
  const state = store.get(keyFor(userId, bucket));
  if (!state) return 0;
  const deficit = 1 - state.tokens;
  if (deficit <= 0) return 0;
  return Math.max(1, Math.ceil(deficit / config.refillPerMs / 1000));
}

/** Test-only: clear all buckets so tests do not bleed into one another. */
export function __resetRateLimits(): void {
  store.clear();
}
