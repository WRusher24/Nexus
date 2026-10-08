/**
 * GET /api/search?q=...&limit=... (M8, Part 4.1).
 *
 * Wraps M5's SearchService. The client is built lazily from env; tests inject a
 * fixture-backed service via `__setSearchServiceForTests`.
 */

import { z } from 'zod';
import { requireUser } from '../../../lib/auth/session';
import {
  internalError,
  serviceUnavailable,
  tooManyRequests,
} from '../../../lib/http/errors';
import { checkRateLimit, retryAfterSeconds } from '../../../lib/http/rateLimit';
import { jsonOk } from '../../../lib/http/responses';
import { getSearchServiceOverride } from '../../../lib/http/testOverrides';
import { parseSearchParams } from '../../../lib/http/validation';
import { createResolver } from '../../../lib/wikipedia/qidResolver';
import { RateLimiter } from '../../../lib/wikipedia/rateLimit';
import { createSearchService, type SearchService } from '../../../lib/wikipedia/search';
import { createWikidataClient } from '../../../lib/wikipedia/wikidataClient';
import {
  createWikipediaClient,
  WikipediaError,
} from '../../../lib/wikipedia/wikipediaClient';

export const runtime = 'nodejs';

const querySchema = z.object({
  q: z.string().min(1, 'q is required').max(200, 'q must be at most 200 characters'),
  limit: z.coerce.number().int().min(1).max(10).default(5),
});

let productionService: SearchService | null = null;

function buildProductionService(): SearchService {
  const contactEmail = process.env.WIKIPEDIA_CONTACT_EMAIL;
  if (!contactEmail) {
    throw new Error('WIKIPEDIA_CONTACT_EMAIL is required to search Wikipedia');
  }
  const rateLimiter = new RateLimiter({ requestsPerSecond: 10 });
  const wikipedia = createWikipediaClient({ contactEmail, rateLimiter });
  const wikidata = createWikidataClient({ contactEmail, rateLimiter });
  return createSearchService({
    wikipedia,
    wikidata,
    resolver: createResolver(wikidata),
  });
}

function getSearchService(): SearchService {
  const override = getSearchServiceOverride();
  if (override) return override;
  if (!productionService) productionService = buildProductionService();
  return productionService;
}

export async function GET(request: Request): Promise<Response> {
  const userId = await requireUser(request);
  if (userId instanceof Response) return userId;

  const url = new URL(request.url);
  const params = parseSearchParams(url, querySchema);
  if (params instanceof Response) return params;

  if (!checkRateLimit(userId, 'search')) {
    return tooManyRequests(
      'Search rate limit exceeded',
      retryAfterSeconds(userId, 'search'),
    );
  }

  try {
    const candidates = await getSearchService().search(params.q, params.limit);
    return jsonOk({ candidates });
  } catch (error) {
    if (error instanceof WikipediaError) {
      return serviceUnavailable('Wikipedia is unreachable');
    }
    return internalError(error);
  }
}
