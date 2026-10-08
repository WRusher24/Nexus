/**
 * GET /api/admin/audit (M9, Part 6.1).
 *
 * Runs the invariant audits (P1–P6) programmatically and returns a pass/fail
 * summary. Authorized by a valid cron secret (for Vercel Cron) or a signed-in
 * user whose email is in `ADMIN_EMAILS`.
 */

import { runInvariantAudit } from '@/lib/db/audit';
import {
  authorizeAdmin,
  createDbAuditRunner,
} from '@/lib/hardening/auditScheduler';
import { getDb } from '@/lib/http/db';
import { internalError } from '@/lib/http/errors';
import { jsonOk } from '@/lib/http/responses';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const denied = await authorizeAdmin(request);
  if (denied) return denied;

  try {
    const db = await getDb();
    const results = await runInvariantAudit(createDbAuditRunner(db));
    const passed = results.filter((result) => result.pass).length;

    return jsonOk({
      timestamp: new Date().toISOString(),
      totalAudits: results.length,
      passed,
      failed: results.length - passed,
      results,
    });
  } catch (error) {
    return internalError(error);
  }
}
