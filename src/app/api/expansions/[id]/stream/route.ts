/**
 * GET /api/expansions/{id}/stream (M8, Part 4.7) — Server-Sent Events.
 *
 * Polls the expansion request every 2s (production) and emits `status` events
 * on change, then `close` at a terminal state or `timeout` after 120s. Auth /
 * ownership failures return plain JSON (not SSE), as specified.
 *
 * `maxDuration = 120` documents the Vercel constraint; on a container host no
 * function-duration limit applies.
 */

import { eq } from 'drizzle-orm';
import { requireUser } from '../../../../../lib/auth/session';
import { expansionRequests } from '../../../../../lib/db/schema';
import {
  badRequest,
  forbidden,
  internalError,
  notFound,
} from '../../../../../lib/http/errors';
import { getDb } from '../../../../../lib/http/db';
import { isUuid } from '../../../../../lib/http/validation';
import {
  fetchExpansionStatus,
  isTerminalStatus,
  type ExpansionStatusSnapshot,
} from '../../../../../lib/sse/pollExpansion';
import { createSseStream, SSE_HEADERS } from '../../../../../lib/sse/stream';

export const runtime = 'nodejs';
export const maxDuration = 120;

export interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Shape of a `status` SSE payload. Only relevant fields are included. */
function serializeStatus(snapshot: ExpansionStatusSnapshot): unknown {
  const payload: Record<string, unknown> = {
    status: snapshot.status,
    attempt: snapshot.attempt,
  };
  if (snapshot.extractionRunId !== null) {
    payload.extractionRunId = snapshot.extractionRunId;
  }
  if (snapshot.lastError !== null) {
    payload.lastError = snapshot.lastError;
  }
  if (isTerminalStatus(snapshot.status) && snapshot.finalState !== null) {
    payload.finalState = snapshot.finalState;
  }
  return payload;
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const userId = await requireUser(request);
  if (userId instanceof Response) return userId;

  const { id } = await context.params;
  if (!isUuid(id)) return badRequest('Invalid expansion request id');

  let initial: ExpansionStatusSnapshot | null;
  try {
    const db = await getDb();

    const [ownership] = await db
      .select({ requestedBy: expansionRequests.requestedBy })
      .from(expansionRequests)
      .where(eq(expansionRequests.id, id))
      .limit(1);

    if (!ownership) return notFound('Expansion request not found');
    if (ownership.requestedBy !== userId) {
      return forbidden('This expansion request belongs to another user');
    }

    initial = await fetchExpansionStatus(db, id);
    if (!initial) return notFound('Expansion request not found');

    const stream = createSseStream<ExpansionStatusSnapshot>({
      signal: request.signal,
      initial,
      poll: () => fetchExpansionStatus(db, id),
      serialize: serializeStatus,
      isTerminal: (snapshot) => isTerminalStatus(snapshot.status),
    });

    return new Response(stream, { headers: SSE_HEADERS });
  } catch (error) {
    return internalError(error);
  }
}
