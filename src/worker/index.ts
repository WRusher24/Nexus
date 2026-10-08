#!/usr/bin/env tsx
/**
 * Worker entry point (M7, Part 11). Replaces the M1 placeholder.
 *
 * Runs the expansion queue drain loop in a long-lived process. This CANNOT run
 * in Vercel serverless (execution timeout); it belongs in a container (Railway,
 * Render, Fly, or a VPS). `pnpm run worker` is the container entrypoint.
 *
 * Local imports are relative rather than `@/...`: the `@/*` path alias is
 * resolved by Next.js / tsc but not guaranteed under the `tsx` runtime.
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

import { getProvider } from '../lib/extraction/provider';
import type { ExtractionConfig } from '../lib/extraction/types';
import { createSourceDocumentService } from '../lib/wikipedia/sourceDocuments';
import { createResolver } from '../lib/wikipedia/qidResolver';
import { RateLimiter } from '../lib/wikipedia/rateLimit';
import { createWikidataClient } from '../lib/wikipedia/wikidataClient';
import { createWikipediaClient } from '../lib/wikipedia/wikipediaClient';
import type { Database } from '../lib/graph/types';
import { registerShutdownSignals } from './graceful';
import { runWorkerLoop } from './runLoop';

async function main(): Promise<void> {
  const workerId = process.env.WORKER_ID || `worker-${process.pid}-${Date.now()}`;
  const contactEmail = process.env.WIKIPEDIA_CONTACT_EMAIL;
  if (!contactEmail) {
    console.error('WIKIPEDIA_CONTACT_EMAIL env var required');
    process.exit(1);
  }

  // Imported dynamically so `.env.local` is loaded before the client reads
  // DATABASE_URL. The client returns a union of the Neon-HTTP and node-postgres
  // Drizzle types; the queue is typed against NodePgDatabase.
  const { db } = await import('../lib/db/client');
  const database = db as unknown as Database;

  const provider = getProvider();

  const rateLimiter = new RateLimiter({ requestsPerSecond: 10 });
  const wikipedia = createWikipediaClient({ contactEmail, rateLimiter });
  const wikidata = createWikidataClient({ contactEmail, rateLimiter });
  const resolver = createResolver(wikidata);
  const sourceDocuments = createSourceDocumentService({ db: database, wikipedia });

  const config: ExtractionConfig = {
    provider,
    sourceDocumentService: sourceDocuments,
    resolver,
    wikipedia,
    wikidata,
  };

  const signal = registerShutdownSignals();

  console.log(`Worker ${workerId} starting with provider ${provider.providerId}`);
  await runWorkerLoop(database, { workerId, config, signal });
  console.log(`Worker ${workerId} shut down`);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error('Worker crashed:', error);
  process.exit(1);
});
