/**
 * GET /api/expansions/{id} (M8, Part 4.6).
 *
 * Status snapshot for a single expansion request. v1 restricts visibility to
 * the requesting user.
 */

import { eq } from 'drizzle-orm';
import { requireUser } from '../../../../lib/auth/session';
import { expansionRequests } from '../../../../lib/db/schema';
import { badRequest, forbidden, internalError, notFound } from '../../../../lib/http/errors';
import { getDb } from '../../../../lib/http/db';
import { jsonOk } from '../../../../lib/http/responses';
import { isUuid } from '../../../../lib/http/validation';

export const runtime = 'nodejs';

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
  if (!isUuid(id)) return badRequest('Invalid expansion request id');

  try {
    const db = await getDb();
    const [row] = await db
      .select({
        requestId: expansionRequests.id,
        nodeId: expansionRequests.nodeId,
        direction: expansionRequests.direction,
        status: expansionRequests.status,
        attempt: expansionRequests.attempt,
        createdAt: expansionRequests.createdAt,
        updatedAt: expansionRequests.updatedAt,
        extractionRunId: expansionRequests.extractionRunId,
        lastError: expansionRequests.lastError,
        requestedBy: expansionRequests.requestedBy,
      })
      .from(expansionRequests)
      .where(eq(expansionRequests.id, id))
      .limit(1);

    if (!row) return notFound('Expansion request not found');
    if (row.requestedBy !== userId) {
      return forbidden('This expansion request belongs to another user');
    }

    return jsonOk({
      requestId: row.requestId,
      nodeId: row.nodeId,
      direction: row.direction,
      status: row.status,
      attempt: row.attempt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      extractionRunId: row.extractionRunId,
      lastError: row.lastError,
    });
  } catch (error) {
    return internalError(error);
  }
}
