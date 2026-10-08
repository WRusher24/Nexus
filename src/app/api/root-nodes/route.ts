/**
 * POST /api/root-nodes (M8, Part 4.2).
 *
 * Wraps M5's `createRootNode`. The Wikipedia/Wikidata-backed dependencies are
 * built lazily; tests inject fixture-backed ones through
 * `__setRootNodeDepsForTests` in `src/lib/http/testOverrides.ts` (route modules
 * may not export test hooks — Next.js validates route exports at build time).
 */

import { z } from 'zod';
import { requireUser } from '../../../lib/auth/session';
import type { Database } from '../../../lib/graph/types';
import { createRootNode } from '../../../lib/graph/createRootNode';
import { getDb } from '../../../lib/http/db';
import { internalError, serviceUnavailable } from '../../../lib/http/errors';
import { jsonCreated, jsonOk } from '../../../lib/http/responses';
import {
  getRootNodeDepsOverride,
  type RootNodeDeps,
} from '../../../lib/http/testOverrides';
import { parseJsonBody } from '../../../lib/http/validation';
import { RateLimiter } from '../../../lib/wikipedia/rateLimit';
import { createSourceDocumentService } from '../../../lib/wikipedia/sourceDocuments';
import { createWikidataClient } from '../../../lib/wikipedia/wikidataClient';
import {
  createWikipediaClient,
  WikipediaError,
} from '../../../lib/wikipedia/wikipediaClient';

export const runtime = 'nodejs';

const candidateSchema = z.object({
  pageId: z.number().int().positive(),
  title: z.string().min(1).max(500),
  snippet: z.string().max(10_000),
  wordCount: z.number().int().nonnegative(),
  resolvedQid: z.string().max(64).nullable(),
  qidConfidence: z.enum(['HIGH', 'MEDIUM', 'LOW', 'NONE']),
});

let productionDeps: RootNodeDeps | null = null;

function buildProductionDeps(db: Database): RootNodeDeps {
  const contactEmail = process.env.WIKIPEDIA_CONTACT_EMAIL;
  if (!contactEmail) {
    throw new Error('WIKIPEDIA_CONTACT_EMAIL is required to create a root node');
  }
  const rateLimiter = new RateLimiter({ requestsPerSecond: 10 });
  const wikipedia = createWikipediaClient({ contactEmail, rateLimiter });
  const wikidata = createWikidataClient({ contactEmail, rateLimiter });
  return {
    sourceDocuments: createSourceDocumentService({ db, wikipedia }),
    wikidata,
  };
}

function getDeps(db: Database): RootNodeDeps {
  const override = getRootNodeDepsOverride();
  if (override) return override;
  if (!productionDeps) productionDeps = buildProductionDeps(db);
  return productionDeps;
}

export async function POST(request: Request): Promise<Response> {
  const userId = await requireUser(request);
  if (userId instanceof Response) return userId;

  const body = await parseJsonBody(request, candidateSchema);
  if (body instanceof Response) return body;

  const db = await getDb();
  const deps = getDeps(db);

  try {
    const result = await createRootNode(db, deps.sourceDocuments, deps.wikidata, {
      candidate: body,
    });
    const payload = {
      nodeId: result.nodeId,
      sourceDocumentId: result.sourceDocumentId,
      qid: result.qid,
      outcome: result.outcome,
    };
    return result.outcome === 'CREATED'
      ? jsonCreated(payload)
      : jsonOk(payload);
  } catch (error) {
    if (error instanceof WikipediaError) {
      return serviceUnavailable('Wikipedia is unreachable');
    }
    return internalError(error);
  }
}
