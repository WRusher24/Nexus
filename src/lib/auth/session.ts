/**
 * Auth helpers for API routes (M8, Part 2.4).
 *
 * `requireUser` is the guard every protected route calls first:
 *
 *   const userId = await requireUser(request);
 *   if (userId instanceof Response) return userId;   // 401
 *
 * Session resolution has a test-only override. Importing the full Auth.js
 * config eagerly would construct the adapter and require request-scoped
 * headers; instead the config is imported lazily and only when no override is
 * installed. Tests install an override via `__setTestSession`.
 */

import { unauthorized } from '../http/errors';

interface SessionOverride {
  userId: string | null;
}

/**
 * `undefined` means "no override" (production path). A defined value (possibly
 * `{ userId: null }`) means the test harness has pinned the session.
 */
let testOverride: SessionOverride | undefined;

/**
 * Test-only: pin the session for subsequent `requireUser` /
 * `getOptionalUserId` calls. Pass `null` to simulate "unauthenticated".
 */
export function __setTestSession(session: { userId: string } | null): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__setTestSession is test-only');
  }
  testOverride = session ? { userId: session.userId } : { userId: null };
}

/** Test-only: remove the override and fall back to real Auth.js resolution. */
export function __clearTestSession(): void {
  testOverride = undefined;
}

async function readSessionUserId(): Promise<string | null> {
  if (testOverride !== undefined) {
    return testOverride.userId;
  }

  try {
    const { auth } = await import('./config');
    const session = await auth();
    const user = session?.user as { id?: string } | undefined;
    return user?.id ?? null;
  } catch {
    // Outside a Next.js request scope (or a transient failure): treat as
    // unauthenticated rather than throwing.
    return null;
  }
}

/**
 * Returns the authenticated user id, or a 401 `Response` the caller must
 * forward. The `request` argument is accepted for signature symmetry with
 * future cookie-based resolution; the current implementation reads the
 * framework session context.
 */
export async function requireUser(
  request: Request,
): Promise<string | Response> {
  void request; // Part of the public contract; session context is framework-provided.
  const userId = await readSessionUserId();
  if (!userId) return unauthorized('Authentication required');
  return userId;
}

/** Returns the user id or null without producing a Response. */
export async function getOptionalUserId(
  request?: Request,
): Promise<string | null> {
  void request; // Part of the public contract; see `requireUser`.
  return readSessionUserId();
}
