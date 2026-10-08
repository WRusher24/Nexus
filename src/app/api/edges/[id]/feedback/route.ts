/**
 * POST /api/edges/{id}/feedback (M8, Part 4.8).
 *
 * Stores a user's feedback on an edge, then applies the auto-hide rule
 * (>= 2 distinct INCORRECT reporters). Duplicate feedback from the same user
 * for the same edge is rejected with 409.
 */

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireUser } from '../../../../../lib/auth/session';
import { edgeFeedback, edges } from '../../../../../lib/db/schema';
import { checkAutoHide } from '../../../../../lib/feedback/autoHide';
import {
  badRequest,
  conflict,
  internalError,
  notFound,
} from '../../../../../lib/http/errors';
import { getDb } from '../../../../../lib/http/db';
import { jsonCreated } from '../../../../../lib/http/responses';
import { isUuid, parseJsonBody } from '../../../../../lib/http/validation';

export const runtime = 'nodejs';

const feedbackSchema = z.object({
  type: z.enum(['INCORRECT', 'MISSING', 'DUPLICATE', 'SPAM']),
  note: z.string().max(2000).optional(),
});

export interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const userId = await requireUser(request);
  if (userId instanceof Response) return userId;

  const { id } = await context.params;
  if (!isUuid(id)) return badRequest('Invalid edge id');

  const body = await parseJsonBody(request, feedbackSchema);
  if (body instanceof Response) return body;

  try {
    const db = await getDb();

    const [edge] = await db
      .select({ id: edges.id })
      .from(edges)
      .where(eq(edges.id, id))
      .limit(1);
    if (!edge) return notFound('Edge not found');

    const [existing] = await db
      .select({ id: edgeFeedback.id })
      .from(edgeFeedback)
      .where(
        and(eq(edgeFeedback.edgeId, id), eq(edgeFeedback.userId, userId)),
      )
      .limit(1);
    if (existing) {
      return conflict('You have already submitted feedback for this edge');
    }

    const [inserted] = await db
      .insert(edgeFeedback)
      .values({
        edgeId: id,
        userId,
        type: body.type,
        note: body.note ?? null,
      })
      .returning({ id: edgeFeedback.id });

    if (!inserted) {
      return internalError(new Error('feedback insert returned no row'));
    }

    const autoHide = await checkAutoHide(db, id);

    return jsonCreated({ feedbackId: inserted.id, autoHidden: autoHide.hidden });
  } catch (error) {
    return internalError(error);
  }
}
