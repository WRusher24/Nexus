/**
 * Date interval algebra (Amendment A6).
 *
 * Converts a `PartialDate` (as extracted from the LLM / stored on a node) into
 * the closed year interval representing its plausible range, and answers the
 * two comparison questions used by the chronology check.
 *
 * Pure functions; no I/O.
 */

/**
 * The seven precision levels mirror `datePrecisionEnum` in schema.ts.
 * Keep this enum in sync with the database. If the DB enum changes, this
 * must change too. (A unit test asserts parity with the Drizzle enum.)
 */
export type DatePrecision =
  | 'DAY'
  | 'MONTH'
  | 'YEAR'
  | 'DECADE'
  | 'CENTURY'
  | 'MILLENNIUM'
  | 'UNKNOWN';

export interface PartialDate {
  /** Signed year. Negative = BCE. Null when precision is UNKNOWN. */
  year: number | null;
  /** 1-12 or null. */
  month: number | null;
  /** 1-31 or null. */
  day: number | null;
  precision: DatePrecision;
}

/**
 * A closed year interval representing the plausible range of a date.
 * Both endpoints are inclusive.
 */
export interface YearInterval {
  earliest: number;
  latest: number;
}

/**
 * Convert a PartialDate to a YearInterval, or null if precision is UNKNOWN or
 * the year needed for the precision is missing.
 *
 * BCE handling: negative years use astronomical numbering (year 0 = 1 BCE,
 * matching the project convention; year 0 is not skipped).
 */
export function toYearInterval(date: PartialDate): YearInterval | null {
  if (date.precision === 'UNKNOWN') return null;
  if (date.year === null) return null;

  const year = date.year;
  switch (date.precision) {
    case 'DAY':
    case 'MONTH':
    case 'YEAR':
      return { earliest: year, latest: year };
    case 'DECADE':
      return { earliest: year, latest: year + 9 };
    case 'CENTURY':
      return { earliest: year, latest: year + 99 };
    case 'MILLENNIUM':
      return { earliest: year, latest: year + 999 };
    default:
      return null;
  }
}

/** True if the two intervals overlap at any point (endpoints inclusive). */
export function intervalsOverlap(a: YearInterval, b: YearInterval): boolean {
  return a.earliest <= b.latest && b.earliest <= a.latest;
}

/**
 * True if interval `a` could precede or equal interval `b` (i.e.
 * `a.earliest <= b.latest`). This is the condition for "a could be a valid
 * cause of b."
 */
export function couldPrecede(a: YearInterval, b: YearInterval): boolean {
  return a.earliest <= b.latest;
}
