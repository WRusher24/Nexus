/**
 * Scheduled invariant audits (M9, Part 6.4).
 *
 * Two deployment shapes share this module:
 *   - Vercel Cron hits `GET /api/admin/audit` with the `CRON_SECRET` header.
 *   - A container host can call `startAuditScheduler(...)` from a small cron
 *     entrypoint; it runs `runScheduledAudit` on an interval and logs failures.
 *
 * It also owns the admin authorization used by all `/api/admin/*` routes:
 * a valid cron secret, or a signed-in user whose email is in `ADMIN_EMAILS`.
 * An unset/empty `ADMIN_EMAILS` denies everyone (fail closed).
 */

import { timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { requireUser } from '../auth/session';
import {
  runInvariantAudit,
  type AuditQueryRunner,
  type AuditResult,
} from '../db/audit';
import { forbidden } from '../http/errors';
import type { Database } from '../graph/types';

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Constant-time string compare that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Adapt a Drizzle database handle to the audit runner shape. Used by the admin
 * route and by container-host schedulers that already hold a `Database`.
 */
export function createDbAuditRunner(db: Database): AuditQueryRunner {
  return async (sqlText: string) => {
    const result = await db.execute<Record<string, unknown>>(sql.raw(sqlText));
    return result.rows;
  };
}

/**
 * True when the request carries the configured `CRON_SECRET` in either
 * `x-cron-secret` or `Authorization: Bearer <secret>`. Returns false when no
 * secret is configured (Vercel cron auth is opt-in).
 */
export function hasValidCronSecret(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const raw =
    request.headers.get('x-cron-secret') ??
    request.headers.get('authorization');
  if (!raw) return false;
  const value = raw.startsWith('Bearer ') ? raw.slice(7) : raw;
  return safeEqual(value, secret);
}

/** Parse `ADMIN_EMAILS` into a normalised list. */
export function getAdminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/** True when `email` is an administrator. Empty allowlist → deny all. */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const admins = getAdminEmails();
  if (admins.length === 0) return false;
  return admins.includes(email.trim().toLowerCase());
}

/** Resolve the signed-in user's email (or null outside a request scope). */
export async function getSessionEmail(): Promise<string | null> {
  try {
    const { auth } = await import('../auth/config');
    const session = await auth();
    const user = session?.user as { email?: string | null } | undefined;
    return user?.email ?? null;
  } catch {
    return null;
  }
}

/**
 * Authorization gate for `/api/admin/*`. Returns `null` when allowed, or a
 * `Response` the caller must forward. Cron requests bypass the user check;
 * everything else needs a signed-in admin.
 */
export async function authorizeAdmin(request: Request): Promise<Response | null> {
  if (hasValidCronSecret(request)) return null;

  const userId = await requireUser(request);
  if (userId instanceof Response) return userId;

  const email = await getSessionEmail();
  if (!isAdminEmail(email)) {
    return forbidden('Admin access required');
  }
  return null;
}

/**
 * Run all invariant audits and log a compact summary. Returns the results so
 * the caller can attach them to an HTTP response.
 */
export async function runScheduledAudit(
  runner: AuditQueryRunner,
): Promise<AuditResult[]> {
  const results = await runInvariantAudit(runner);
  const failed = results.filter((result) => !result.pass);
  if (failed.length > 0) {
    console.error(
      `[audit] ${failed.length}/${results.length} audits FAILED:`,
      failed.map((result) => `${result.name} (${result.violations})`).join(', '),
    );
  } else {
    console.log(`[audit] ${results.length}/${results.length} audits passed`);
  }
  return results;
}

/**
 * Container-host scheduler. Starts an interval that runs the audit; the
 * returned function stops it. Not wired into the Next.js process by default —
 * call it from a dedicated cron entrypoint (see docs/DEPLOY.md).
 */
export function startAuditScheduler(
  runner: AuditQueryRunner,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    void runScheduledAudit(runner).catch((error: unknown) => {
      console.error('[audit] scheduled run failed:', error);
    });
  }, intervalMs);
  // Do not keep the process alive just for the audit timer.
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
