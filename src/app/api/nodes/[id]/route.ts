/**
 * GET /api/nodes/{id}?limit=... (M8, Part 4.3).
 *
 * Wraps M4's `getNodeNeighborhood`, adding `isRoot` (the traversal projection
 * does not carry it) and returning the node + bounded causes/effects.
 */

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireUser } from '../../../../lib/auth/session';
import { nodes } from '../../../../lib/db/schema';
import { getNodeNeighborhood } from '../../../../lib/graph/traversal';
import { badRequest, internalError, notFound } from '../../../../lib/http/errors';
import { getDb } from '../../../../lib/http/db';
import { jsonOk } from '../../../../lib/http/responses';
import { isUuid, parseSearchParams } from '../../../../lib/http/validation';

export const runtime = 'nodejs';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(10),
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
    const neighborhood = await getNodeNeighborhood(db, id, params.limit);
    if (!neighborhood) return notFound('Node not found');

    const [rootRow] = await db
      .select({ isRoot: nodes.isRoot })
      .from(nodes)
      .where(eq(nodes.id, id))
      .limit(1);

    return jsonOk({
      node: { ...neighborhood.node, isRoot: rootRow?.isRoot ?? false },
      causes: neighborhood.causes,
      effects: neighborhood.effects,
    });
  } catch (error) {
    return internalError(error);
  }
}
