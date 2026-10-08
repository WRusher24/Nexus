import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-http';
import { drizzle as drizzleNode } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

/**
 * Drizzle client factory.
 *
 * Nexus runs against two flavours of PostgreSQL:
 *   - Production: Neon, reached over the serverless HTTP driver.
 *   - Local dev / CI: a plain Postgres (Docker / GitHub Actions service),
 *     reached over TCP with node-postgres.
 *
 * We pick the driver from `DATABASE_URL`. The Neon HTTP driver is used for
 * `*.neon.tech` hosts; everything else falls back to node-postgres. This keeps
 * the local and CI environments free of the Neon WebSocket proxy.
 */
function resolveDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env.local, or export it in the environment.',
    );
  }
  return url;
}

function createDb() {
  const url = resolveDatabaseUrl();

  if (url.includes('neon.tech')) {
    return drizzleNeon(neon(url), { schema });
  }

  return drizzleNode(new Pool({ connectionString: url }), { schema });
}

export const db = createDb();

export type Database = ReturnType<typeof createDb>;
