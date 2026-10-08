/**
 * Atomic global budget reservation (P6, Amendment A9).
 *
 * The extraction cost is pre-reserved BEFORE the LLM call so that concurrent
 * extractions cannot collectively overshoot the daily/monthly caps. A single
 * conditional UPDATE does the work; if it affects zero rows the budget (or the
 * pause switch) blocked the reservation and the caller must abort.
 *
 * The reservation id exists only for tracing/logging; there is no reservations
 * table. Reconciliation adjusts the spent counters from the reserved amount to
 * the actual amount (which is the reserved amount again on a failed call that
 * incurred no cost).
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from '../graph/types';

export interface BudgetReservation {
  reservationId: string;
  reservedAmountUsd: number;
}

/**
 * Atomically attempt to reserve budget. Returns the reservation on success or
 * `null` when the budget is exhausted or the system is paused.
 */
export async function reserveBudget(
  db: Database,
  estimatedCostUsd: number,
): Promise<BudgetReservation | null> {
  const amount = Math.max(0, estimatedCostUsd);

  return db.transaction(async (tx) => {
    // Roll the day over (and zero today's spend) before checking the cap.
    await tx.execute(sql`
      UPDATE "globalBudget"
      SET "spentTodayUsd" = 0, "currentDay" = CURRENT_DATE, "updatedAt" = NOW()
      WHERE "id" = 'singleton' AND "currentDay" < CURRENT_DATE
    `);

    // Roll the month over.
    await tx.execute(sql`
      UPDATE "globalBudget"
      SET "spentThisMonthUsd" = 0, "currentMonth" = CURRENT_DATE, "updatedAt" = NOW()
      WHERE "id" = 'singleton'
        AND date_trunc('month', "currentMonth") < date_trunc('month', CURRENT_DATE)
    `);

    const result = await tx.execute<{
      spentTodayUsd: number;
      spentThisMonthUsd: number;
    }>(sql`
      UPDATE "globalBudget"
      SET
        "spentTodayUsd" = "spentTodayUsd" + ${amount},
        "spentThisMonthUsd" = "spentThisMonthUsd" + ${amount},
        "updatedAt" = NOW()
      WHERE "id" = 'singleton'
        AND NOT "isPaused"
        AND ("spentTodayUsd" + ${amount}) <= "dailyBudgetUsd"
        AND ("spentThisMonthUsd" + ${amount}) <= "monthlyBudgetUsd"
      RETURNING "spentTodayUsd", "spentThisMonthUsd"
    `);

    if (result.rows.length === 0) return null;

    return { reservationId: randomUUID(), reservedAmountUsd: amount };
  });
}

/**
 * Reconcile a reservation with the actual cost. On a failed extraction pass
 * `actualCostUsd = 0` to refund the reservation in full.
 */
export async function reconcileBudget(
  db: Database,
  reservation: BudgetReservation,
  actualCostUsd: number,
): Promise<void> {
  const delta = actualCostUsd - reservation.reservedAmountUsd;

  await db.execute(sql`
    UPDATE "globalBudget"
    SET
      "spentTodayUsd" = GREATEST(0, "spentTodayUsd" + ${delta}),
      "spentThisMonthUsd" = GREATEST(0, "spentThisMonthUsd" + ${delta}),
      "updatedAt" = NOW()
    WHERE "id" = 'singleton'
  `);
}
