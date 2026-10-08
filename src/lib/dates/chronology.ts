/**
 * Deterministic chronology comparison (Amendment A6, invariant P2).
 *
 * Given the stored dates of a proposed cause and effect, decide whether the
 * causal edge is chronologically plausible. Pure; no I/O. When either node
 * already exists, its stored dates are passed in here rather than the LLM's
 * restated dates.
 */

import { couldPrecede, toYearInterval, type PartialDate, type YearInterval } from './intervals';

export type ChronologyResult =
  | { status: 'VERIFIED' } // cause.earliest <= effect.latest, both known
  | { status: 'UNVERIFIED' } // one or both dates unknown; cannot judge
  | { status: 'VIOLATION'; reason: string }; // cause.earliest > effect.latest

function formatInterval(interval: YearInterval): string {
  if (interval.earliest === interval.latest) return `${interval.earliest}`;
  return `${interval.earliest}–${interval.latest}`;
}

/**
 * Check whether a proposed causal edge is chronologically plausible.
 *
 * Rules (Amendment A6):
 *   - If either date has precision UNKNOWN or converts to a null interval:
 *     return UNVERIFIED.
 *   - If cause.earliest > effect.latest: return VIOLATION with a human
 *     readable reason including both year ranges.
 *   - Otherwise: return VERIFIED.
 */
export function checkChronology(
  causeDate: PartialDate,
  effectDate: PartialDate,
): ChronologyResult {
  const cause = toYearInterval(causeDate);
  const effect = toYearInterval(effectDate);

  if (cause === null || effect === null) {
    return { status: 'UNVERIFIED' };
  }

  if (!couldPrecede(cause, effect)) {
    return {
      status: 'VIOLATION',
      reason:
        `Chronology violation: cause interval ${formatInterval(cause)} ` +
        `starts after effect interval ${formatInterval(effect)} ` +
        `(cause.earliest ${cause.earliest} > effect.latest ${effect.latest}).`,
    };
  }

  return { status: 'VERIFIED' };
}
