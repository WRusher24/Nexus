/**
 * GET /api/nodes/{id}/ancestors?depth=... (M8, Part 4.4).
 *
 * Bounded upstream traversal via M4's `getAncestors`.
 */

import { z } from 'zod';
import { requireUser } from '../../../../../lib/auth/session';
import { getAncestors } from '../../../../../lib/graph/traversal';
import { badRequest, internalError } from '../../../../../lib/http/errors';
import { getDb } from '../../../../../lib/http/db';
import { jsonOk } from '../../../../../lib/http/responses';
import { isUuid, parseSearchParams } from '../../../../../lib/http/validation';

export const runtime = 'nodejs';

const querySchema = z.object({
  depth: z.coerce.number().int().min(1).max(4).default(2),
});

export interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const userId = await requireUser(request);
  if (userId instanceof Response) return userId;

  const { id } = await context.params;
  if (!isUuid(id)) return badRequest('Invalid node id');

  const params = parseSearchParams(new URL(request.url), querySchema);
  if (params instanceof Response) return params;

  try {
    const db = await getDb();
    const result = await getAncestors(db, id, params.depth);
    return jsonOk(result);
  } catch (error) {
    return internalError(error);
  }
}
