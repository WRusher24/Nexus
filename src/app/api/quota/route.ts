/**
 * GET /api/quota (M8, Part 4.9).
 *
 * Current per-user quota state. Creates the quota row with defaults on first
 * call so the frontend always has something to render.
 */

import { requireUser } from '../../../lib/auth/session';
import { internalError } from '../../../lib/http/errors';
import { getDb } from '../../../lib/http/db';
import { jsonOk } from '../../../lib/http/responses';
import { ensureUserQuota, getUserQuota } from '../../../lib/queue';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const userId = await requireUser(request);
  if (userId instanceof Response) return userId;

  try {
    const db = await getDb();
    await ensureUserQuota(db, userId);
    const quota = await getUserQuota(db, userId);

    const expansionsToday = quota?.expansionsToday ?? 0;
    const expansionsThisMonth = quota?.expansionsThisMonth ?? 0;
    const dailyLimit = quota?.dailyLimit ?? 20;
    const monthlyLimit = quota?.monthlyLimit ?? 200;

    return jsonOk({
      expansionsToday,
      expansionsThisMonth,
      dailyLimit,
      monthlyLimit,
      remainingToday: Math.max(0, dailyLimit - expansionsToday),
      remainingThisMonth: Math.max(0, monthlyLimit - expansionsThisMonth),
    });
  } catch (error) {
    return internalError(error);
  }
}
