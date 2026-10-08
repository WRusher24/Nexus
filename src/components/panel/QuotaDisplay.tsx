'use client';

/**
 * Quota badge (M9, Part 4.4): "N/M expansions today", yellow under 5
 * remaining, red at zero. Refreshed after every expansion by the container.
 */

import { useEffect } from 'react';
import { api } from '@/lib/frontend/api';
import { useGraphStore } from '@/lib/frontend/store';

export default function QuotaDisplay() {
  const quota = useGraphStore((store) => store.quota);
  const setQuota = useGraphStore((store) => store.setQuota);

  useEffect(() => {
    let cancelled = false;
    void api
      .getQuota()
      .then((result) => {
        if (cancelled) return;
        setQuota({
          remainingToday: result.remainingToday,
          dailyLimit: result.dailyLimit,
        });
      })
      .catch(() => {
        // Quota display is best-effort; the expansion endpoint enforces it.
      });
    return () => {
      cancelled = true;
    };
  }, [setQuota]);

  if (!quota) return null;

  const used = Math.max(0, quota.dailyLimit - quota.remainingToday);
  const color =
    quota.remainingToday <= 0
      ? 'bg-red-100 text-red-800'
      : quota.remainingToday < 5
        ? 'bg-yellow-100 text-yellow-800'
        : 'bg-gray-100 text-gray-700';

  return (
    <div
      data-testid="quota-display"
      className={`rounded-full px-3 py-1 text-xs font-medium shadow-sm ${color}`}
    >
      {used}/{quota.dailyLimit} expansions today
    </div>
  );
}
