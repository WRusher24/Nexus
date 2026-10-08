/**
 * GET /api/admin/cost (M9, Part 6.2).
 *
 * Returns the global budget state plus 24h / 7d extraction-run cost
 * aggregates. Admin-only.
 */

import { authorizeAdmin } from '@/lib/hardening/auditScheduler';
import { buildCostReport } from '@/lib/hardening/costReport';
import { getDb } from '@/lib/http/db';
import { internalError } from '@/lib/http/errors';
import { jsonOk } from '@/lib/http/responses';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const denied = await authorizeAdmin(request);
  if (denied) return denied;

  try {
    const db = await getDb();
    return jsonOk(await buildCostReport(db));
  } catch (error) {
    return internalError(error);
  }
}
