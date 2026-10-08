/**
 * POST /api/expansions (M8, Part 4.5).
 *
 * Wraps M7's `requestExpansion`, mapping its outcome enum onto HTTP statuses.
 */

import { z } from 'zod';
import { requireUser } from '../../../lib/auth/session';
import {
  badRequest,
  forbidden,
  internalError,
  notFound,
  tooManyRequests,
} from '../../../lib/http/errors';
import { getDb } from '../../../lib/http/db';
import { checkRateLimit, retryAfterSeconds } from '../../../lib/http/rateLimit';
import { jsonAccepted, jsonOk } from '../../../lib/http/responses';
import { parseJsonBody, uuidSchema } from '../../../lib/http/validation';
import { getUserQuota, requestExpansion } from '../../../lib/queue';

export const runtime = 'nodejs';

const bodySchema = z.object({
  nodeId: uuidSchema,
  direction: z.enum(['UPSTREAM', 'DOWNSTREAM']),
});

function secondsUntilMidnight(): number {
  const now = new Date();
  const end = new Date(now);
  end.setHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 1000));
}

function secondsUntilMonthEnd(): number {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
  return Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 1000));
}

export async function POST(request: Request): Promise<Response> {
  const userId = await requireUser(request);
  if (userId instanceof Response) return userId;

  const body = await parseJsonBody(request, bodySchema);
  if (body instanceof Response) return body;

  if (!checkRateLimit(userId, 'expansion')) {
    return tooManyRequests(
      'Expansion rate limit exceeded',
      retryAfterSeconds(userId, 'expansion'),
    );
  }

  try {
    const db = await getDb();
    const result = await requestExpansion(db, {
      nodeId: body.nodeId,
      direction: body.direction,
      userId,
    });

    switch (result.outcome) {
      case 'CACHE_HIT':
        return jsonOk(result);

      case 'IN_PROGRESS':
        return jsonOk({
          ...result,
          streamUrl: `/api/expansions/${result.requestId}/stream`,
        });

      case 'QUEUED':
        return jsonAccepted({
          ...result,
          streamUrl: `/api/expansions/${result.requestId}/stream`,
        });

      case 'REJECTED': {
        switch (result.reason) {
          case 'NODE_NOT_FOUND':
            return notFound('Node not found');
          case 'DEPTH_LIMIT_REACHED':
            return forbidden('Depth limit reached');
          case 'QUOTA_EXCEEDED': {
            const quota = await getUserQuota(db, userId);
            const dailyExhausted =
              quota !== null && quota.expansionsToday >= quota.dailyLimit;
            const retryAfter = dailyExhausted
              ? secondsUntilMidnight()
              : secondsUntilMonthEnd();
            return tooManyRequests('Expansion quota exceeded', retryAfter);
          }
          case 'INVALID_INPUT':
          default:
            return badRequest(result.detail);
        }
      }

      default: {
        const exhaustive: never = result;
        return badRequest(`Unexpected expansion outcome: ${String(exhaustive)}`);
      }
    }
  } catch (error) {
    return internalError(error);
  }
}
