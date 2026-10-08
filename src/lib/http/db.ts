/**
 * Lazy database accessor for API routes (M8).
 *
 * The production client is imported lazily so that:
 *   - route modules can be imported by tests without constructing the
 *     production pool, and
 *   - tests can inject the same Drizzle handle they reset between cases
 *     (via `__setDbForTests`, re-exported from `./testOverrides`).
 *
 * `db` in `src/lib/db/client.ts` is a union of the Neon-HTTP and
 * node-postgres flavours; the graph/queue layers are typed against the
 * node-postgres flavour, so it is cast once here (same pattern as the worker).
 */

import type { Database } from '../graph/types';
import { getDbOverride } from './testOverrides';

export { __setDbForTests, __resetDbForTests } from './testOverrides';

let cached: Database | null = null;

/** Return the injected test handle (if any), else the shared production handle. */
export async function getDb(): Promise<Database> {
  const override = getDbOverride();
  if (override) return override;
  if (cached) return cached;
  const { db } = await import('../db/client');
  cached = db as unknown as Database;
  return cached;
}
