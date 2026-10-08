/**
 * Typed errors for the expansion queue (M7).
 *
 * Most queue operations return discriminated-union results instead of throwing
 * (callers must handle CACHE_HIT / IN_PROGRESS / REJECTED explicitly). These
 * errors cover genuinely exceptional conditions — bad input, missing rows, or
 * an internal invariant violation during request creation.
 */

export type QueueErrorCode =
  | 'INVALID_INPUT'
  | 'NODE_NOT_FOUND'
  | 'REQUEST_NOT_FOUND'
  | 'ILLEGAL_TRANSITION'
  | 'INTERNAL';

export class QueueError extends Error {
  constructor(
    public readonly code: QueueErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'QueueError';
  }
}

/**
 * PostgreSQL SQLSTATE 23505 (unique_violation), unwrapped through Drizzle's
 * `DrizzleQueryError.cause` chain. Used to collapse a racing duplicate
 * expansion request onto the winner.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === 'object' && current !== null && 'code' in current) {
      if ((current as { code?: unknown }).code === '23505') return true;
    }
    if (typeof current === 'object' && current !== null && 'cause' in current) {
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return false;
}
