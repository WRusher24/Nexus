import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// Load local env for dev. In CI, DATABASE_URL/DIRECT_URL come from the
// workflow environment, so a missing .env.local is fine.
config({ path: '.env.local' });

export default defineConfig({
  schema: './src/lib/db/schema.ts',
  out: './src/lib/db/migrations',
  dialect: 'postgresql',
  // drizzle-kit connects over TCP using dbCredentials for both local Docker
  // Postgres and Neon (via DIRECT_URL). At runtime the app picks the Neon
  // HTTP driver for neon.tech URLs and node-postgres otherwise; see
  // src/lib/db/client.ts.
  dbCredentials: {
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '',
  },
  verbose: true,
  strict: true,
});
