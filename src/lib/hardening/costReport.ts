/**
 * Cost aggregation queries (M9, Part 6.2).
 *
 * Reads the singleton `globalBudget` row and aggregates recent `extractionRuns`
 * (append-only, P4) into 24h / 7d windows. Kept separate from the route so the
 * SQL is unit-inspectable and reusable by future alerting.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../graph/types';

export interface CostBucket {
  count: number;
  totalCostUsd: number;
  avgCostUsd: number;
}

export interface GlobalBudgetSummary {
  dailyBudgetUsd: number;
  spentTodayUsd: number;
  monthlyBudgetUsd: number;
  spentThisMonthUsd: number;
  isPaused: boolean;
}

export interface CostReport {
  globalBudget: GlobalBudgetSummary;
  recentRuns: {
    last24h: CostBucket;
    last7d: CostBucket;
  };
}

type BudgetRow = {
  dailyBudgetUsd: number | string;
  spentTodayUsd: number | string;
  monthlyBudgetUsd: number | string;
  spentThisMonthUsd: number | string;
  isPaused: boolean;
};

type RunAggregateRow = {
  count: number | string;
  totalCostUsd: number | string | null;
};

function num(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : Number(value);
}

function toBucket(row: RunAggregateRow | undefined): CostBucket {
  const count = num(row?.count);
  const totalCostUsd = num(row?.totalCostUsd);
  return {
    count,
    totalCostUsd,
    avgCostUsd: count > 0 ? totalCostUsd / count : 0,
  };
}

/** Build the admin cost summary for the singleton budget + recent runs. */
export async function buildCostReport(db: Database): Promise<CostReport> {
  const budgetResult = await db.execute<BudgetRow>(sql`
    SELECT
      "dailyBudgetUsd",
      "spentTodayUsd",
      "monthlyBudgetUsd",
      "spentThisMonthUsd",
      "isPaused"
    FROM "globalBudget"
    WHERE "id" = 'singleton'
  `);

  const budget = budgetResult.rows[0];

  const last24hResult = await db.execute<RunAggregateRow>(sql`
    SELECT
      COUNT(*)::int AS "count",
      COALESCE(SUM("estimatedCostUsd"), 0)::float8 AS "totalCostUsd"
    FROM "extractionRuns"
    WHERE "createdAt" >= NOW() - INTERVAL '24 hours'
  `);

  const last7dResult = await db.execute<RunAggregateRow>(sql`
    SELECT
      COUNT(*)::int AS "count",
      COALESCE(SUM("estimatedCostUsd"), 0)::float8 AS "totalCostUsd"
    FROM "extractionRuns"
    WHERE "createdAt" >= NOW() - INTERVAL '7 days'
  `);

  return {
    globalBudget: {
      dailyBudgetUsd: num(budget?.dailyBudgetUsd),
      spentTodayUsd: num(budget?.spentTodayUsd),
      monthlyBudgetUsd: num(budget?.monthlyBudgetUsd),
      spentThisMonthUsd: num(budget?.spentThisMonthUsd),
      isPaused: budget?.isPaused ?? false,
    },
    recentRuns: {
      last24h: toBucket(last24hResult.rows[0]),
      last7d: toBucket(last7dResult.rows[0]),
    },
  };
}
