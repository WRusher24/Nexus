import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  couldPrecede,
  intervalsOverlap,
  toYearInterval,
  type DatePrecision,
  type PartialDate,
} from '../../../lib/dates/intervals';

function date(partial: Partial<PartialDate>): PartialDate {
  return { year: null, month: null, day: null, precision: 'UNKNOWN', ...partial };
}

describe('toYearInterval', () => {
  it('1. YEAR precision yields a single-year interval', () => {
    expect(toYearInterval(date({ year: 1914, precision: 'YEAR' }))).toEqual({
      earliest: 1914,
      latest: 1914,
    });
  });

  it('2. DAY precision ignores month/day for the interval', () => {
    expect(
      toYearInterval(date({ year: 1914, month: 6, day: 28, precision: 'DAY' })),
    ).toEqual({ earliest: 1914, latest: 1914 });
  });

  it('3. MONTH precision ignores the month for the interval', () => {
    expect(toYearInterval(date({ year: 1914, month: 6, precision: 'MONTH' }))).toEqual({
      earliest: 1914,
      latest: 1914,
    });
  });

  it('4. DECADE maps to a ten-year interval', () => {
    expect(toYearInterval(date({ year: 1910, precision: 'DECADE' }))).toEqual({
      earliest: 1910,
      latest: 1919,
    });
  });

  it('5. CENTURY maps to a hundred-year interval', () => {
    expect(toYearInterval(date({ year: 1900, precision: 'CENTURY' }))).toEqual({
      earliest: 1900,
      latest: 1999,
    });
  });

  it('6. MILLENNIUM maps to a thousand-year interval', () => {
    expect(toYearInterval(date({ year: 1000, precision: 'MILLENNIUM' }))).toEqual({
      earliest: 1000,
      latest: 1999,
    });
  });

  it('7. UNKNOWN precision returns null', () => {
    expect(toYearInterval(date({ year: null, precision: 'UNKNOWN' }))).toBeNull();
  });

  it('8. UNKNOWN precision wins even when a year is present', () => {
    expect(toYearInterval(date({ year: 1914, precision: 'UNKNOWN' }))).toBeNull();
  });

  it('9. a missing year returns null', () => {
    expect(toYearInterval(date({ year: null, precision: 'YEAR' }))).toBeNull();
  });

  it('10. BCE year is preserved as a negative interval', () => {
    expect(toYearInterval(date({ year: -44, precision: 'YEAR' }))).toEqual({
      earliest: -44,
      latest: -44,
    });
  });

  it('11. BCE century spans up to -1 (no skipped year zero)', () => {
    expect(toYearInterval(date({ year: -100, precision: 'CENTURY' }))).toEqual({
      earliest: -100,
      latest: -1,
    });
  });
});

describe('intervalsOverlap', () => {
  it('12. overlapping intervals return true', () => {
    expect(intervalsOverlap({ earliest: 1900, latest: 1999 }, { earliest: 1950, latest: 2050 })).toBe(
      true,
    );
  });

  it('13. disjoint intervals return false', () => {
    expect(intervalsOverlap({ earliest: 1900, latest: 1999 }, { earliest: 2000, latest: 2100 })).toBe(
      false,
    );
  });

  it('14. touching endpoints overlap', () => {
    expect(intervalsOverlap({ earliest: 1900, latest: 1999 }, { earliest: 1999, latest: 2000 })).toBe(
      true,
    );
  });
});

describe('couldPrecede', () => {
  it('15. an earlier year could precede a later year', () => {
    expect(couldPrecede({ earliest: 1914, latest: 1914 }, { earliest: 1918, latest: 1918 })).toBe(
      true,
    );
  });

  it('16. a later year could not precede an earlier one', () => {
    expect(couldPrecede({ earliest: 1918, latest: 1918 }, { earliest: 1914, latest: 1914 })).toBe(
      false,
    );
  });

  it('17. a century could precede a single later year', () => {
    expect(couldPrecede({ earliest: 1900, latest: 1999 }, { earliest: 1950, latest: 1950 })).toBe(
      true,
    );
  });

  it('18. a single year could precede the end of a later century', () => {
    expect(couldPrecede({ earliest: 1950, latest: 1950 }, { earliest: 1900, latest: 1999 })).toBe(
      true,
    );
  });

  it('19. a century entirely after another could not precede it', () => {
    expect(couldPrecede({ earliest: 2000, latest: 2099 }, { earliest: 1900, latest: 1999 })).toBe(
      false,
    );
  });
});

describe('interval width property', () => {
  it('20. property: interval width equals precision span minus 1', () => {
    const cases: Array<{ precision: DatePrecision; span: number }> = [
      { precision: 'YEAR', span: 1 },
      { precision: 'DECADE', span: 10 },
      { precision: 'CENTURY', span: 100 },
      { precision: 'MILLENNIUM', span: 1000 },
    ];

    fc.assert(
      fc.property(fc.integer({ min: -10000, max: 10000 }), fc.constantFrom(...cases), (year, c) => {
        const interval = toYearInterval(date({ year, precision: c.precision }));
        if (interval === null) return false;
        return interval.latest - interval.earliest === c.span - 1;
      }),
    );
  });
});
