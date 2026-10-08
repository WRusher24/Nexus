/**
 * Test-only Auth.js session control (M8, Part 5.2).
 *
 * Thin wrapper over the override installed in `src/lib/auth/session.ts`. We
 * use the module-level override (rather than `vi.mock`) so every route handler
 * can be exercised against a real session identity without booting Next.js.
 */

import {
  __clearTestSession,
  __setTestSession,
} from '../../lib/auth/session';

/** Pin the session for subsequent API calls. `null` = unauthenticated. */
export function setTestSession(userId: string | null): void {
  __setTestSession(userId === null ? null : { userId });
}

/** Remove the pinned session. */
export function clearTestSession(): void {
  __clearTestSession();
}
