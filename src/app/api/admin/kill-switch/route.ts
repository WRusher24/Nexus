/**
 * POST /api/admin/kill-switch (M9, Part 6.3).
 *
 * Toggles `GlobalBudget.isPaused` — the emergency stop. While paused,
 * `reserveBudget` fails its conditional UPDATE, so every new expansion is
 * rejected with ABORTED_BUDGET until the switch is flipped back. Admin-only.
 */

import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { authorizeAdmin } from '@/lib/hardening/auditScheduler';
import { getDb } from '@/lib/http/db';
import { internalError } from '@/lib/http/errors';
import { jsonOk } from '@/lib/http/responses';
import { parseJsonBody } from '@/lib/http/validation';

export const runtime = 'nodejs';

const bodySchema = z.object({
  isPaused: z.boolean(),
});

export async function POST(request: Request): Promise<Response> {
  const denied = await authorizeAdmin(request);
  if (denied) return denied;

  const body = await parseJsonBody(request, bodySchema);
  if (body instanceof Response) return body;

  try {
    const db = await getDb();
    const result = await db.execute<{ isPaused: boolean }>(sql`
      UPDATE "globalBudget"
      SET "isPaused" = ${body.isPaused}, "updatedAt" = NOW()
      WHERE "id" = 'singleton'
      RETURNING "isPaused"
    `);

    return jsonOk({ isPaused: result.rows[0]?.isPaused ?? body.isPaused });
  } catch (error) {
    return internalError(error);
  }
}
