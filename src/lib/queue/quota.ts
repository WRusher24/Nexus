/**
 * Per-user quota reservation (M7, Part 3; invariant P6).
 *
 * Quota is reserved BEFORE an ExpansionRequest is created so that concurrent
 * requests cannot collectively exceed a user's daily/monthly cap. The
 * reservation is a single conditional UPDATE: the WHERE clause enforces both
 * limits, so a reservation either succeeds atomically or affects zero rows.
 *
 * Cache hits and join-in-flight paths do NOT reserve quota. A reservation is
 * refunded only when no LLM call was made (ABORTED_BUDGET / ABORTED_NO_SOURCE).
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { userQuotas } from '../db/schema';
import type { Database } from '../graph/types';

export interface QuotaReservation {
  reservationId: string;
  userId: string;
}

export type QuotaReserveFailureReason =
  | 'DAILY_LIMIT_EXCEEDED'
  | 'MONTHLY_LIMIT_EXCEEDED'
  | 'NO_QUOTA_RECORD';

export interface EnsureUserQuotaOptions {
  dailyLimit?: number;
  monthlyLimit?: number;
}

/**
 * Create a UserQuota row for a new user if one doesn't exist. Idempotent.
 * `options` may raise/lower the default limits for testing.
 */
export async function ensureUserQuota(
  db: Database,
  userId: string,
  options: EnsureUserQuotaOptions = {},
): Promise<void> {
  await db
    .insert(userQuotas)
    .values({
      userId,
      ...(options.dailyLimit !== undefined ? { dailyLimit: options.dailyLimit } : {}),
      ...(options.monthlyLimit !== undefined
        ? { monthlyLimit: options.monthlyLimit }
        : {}),
    })
    .onConflictDoNothing({ target: userQuotas.userId });
}

/**
 * Atomically reserve one expansion against the user's quota.
 *
 * Rolls the daily/monthly counters over if the calendar date changed, then
 * increments both counters guarded by the limits. Returns `null` when the
 * quota is exhausted or no record exists.
 */
export async function reserveUserQuota(
  db: Database,
  userId: string,
): Promise<QuotaReservation | null> {
  return db.transaction(async (tx) => {
    // Step 1a: roll the day over.
    await tx.execute(sql`
      UPDATE "userQuotas"
      SET "expansionsToday" = 0, "estimatedCostToday" = 0, "currentDay" = CURRENT_DATE
      WHERE "userId" = ${userId} AND "currentDay" < CURRENT_DATE
    `);

    // Step 1b: roll the month over.
    await tx.execute(sql`
      UPDATE "userQuotas"
      SET "expansionsThisMonth" = 0, "estimatedCostThisMonth" = 0, "currentMonth" = CURRENT_DATE
      WHERE "userId" = ${userId}
        AND date_trunc('month', "currentMonth") < date_trunc('month', CURRENT_DATE)
    `);

    // Step 2: the reservation itself.
    const result = await tx.execute<{ id: string }>(sql`
      UPDATE "userQuotas"
      SET
        "expansionsToday" = "expansionsToday" + 1,
        "expansionsThisMonth" = "expansionsThisMonth" + 1,
        "updatedAt" = NOW()
      WHERE "userId" = ${userId}
        AND "expansionsToday" < "dailyLimit"
        AND "expansionsThisMonth" < "monthlyLimit"
      RETURNING "id"
    `);

    if (result.rows.length === 0) return null;
    return { reservationId: randomUUID(), userId };
  });
}

/**
 * Refund a quota reservation (decrement both counters). Called only when an
 * expansion fails before any LLM call was made. Never refunds below zero.
 */
export async function refundUserQuota(
  db: Database,
  reservation: QuotaReservation,
): Promise<void> {
  await db.execute(sql`
    UPDATE "userQuotas"
    SET
      "expansionsToday" = GREATEST(0, "expansionsToday" - 1),
      "expansionsThisMonth" = GREATEST(0, "expansionsThisMonth" - 1),
      "updatedAt" = NOW()
    WHERE "userId" = ${reservation.userId}
  `);
}

/** Read a user's quota row (used by tests and diagnostics). */
export async function getUserQuota(db: Database, userId: string) {
  const [row] = await db
    .select()
    .from(userQuotas)
    .where(eq(userQuotas.userId, userId))
    .limit(1);
  return row ?? null;
}
