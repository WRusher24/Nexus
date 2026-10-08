import { describe, expect, it } from 'vitest';
import { checkChronology } from '../../../lib/dates/chronology';
import type { PartialDate } from '../../../lib/dates/intervals';

function date(partial: Partial<PartialDate>): PartialDate {
  return { year: null, month: null, day: null, precision: 'UNKNOWN', ...partial };
}

describe('checkChronology', () => {
  it('1. a cause before its effect is VERIFIED', () => {
    expect(
      checkChronology(
        date({ year: 1914, precision: 'YEAR' }),
        date({ year: 1918, precision: 'YEAR' }),
      ),
    ).toEqual({ status: 'VERIFIED' });
  });

  it('2. a cause after its effect is a VIOLATION mentioning both years', () => {
    const result = checkChronology(
      date({ year: 1918, precision: 'YEAR' }),
      date({ year: 1914, precision: 'YEAR' }),
    );
    expect(result.status).toBe('VIOLATION');
    if (result.status !== 'VIOLATION') throw new Error('expected VIOLATION');
    expect(result.reason).toContain('1918');
    expect(result.reason).toContain('1914');
  });

  it('3. same-year causation is VERIFIED', () => {
    expect(
      checkChronology(
        date({ year: 1914, precision: 'YEAR' }),
        date({ year: 1914, precision: 'YEAR' }),
      ),
    ).toEqual({ status: 'VERIFIED' });
  });

  it('4. unknown cause date is UNVERIFIED', () => {
    expect(
      checkChronology(date({ year: null }), date({ year: 1914, precision: 'YEAR' })),
    ).toEqual({ status: 'UNVERIFIED' });
  });

  it('5. unknown effect date is UNVERIFIED', () => {
    expect(
      checkChronology(date({ year: 1914, precision: 'YEAR' }), date({ year: null })),
    ).toEqual({ status: 'UNVERIFIED' });
  });

  it('6. both unknown is UNVERIFIED', () => {
    expect(checkChronology(date({ year: null }), date({ year: null }))).toEqual({
      status: 'UNVERIFIED',
    });
  });

  it('7. a century cause can precede a single-year effect', () => {
    expect(
      checkChronology(
        date({ year: 1900, precision: 'CENTURY' }),
        date({ year: 1914, precision: 'YEAR' }),
      ),
    ).toEqual({ status: 'VERIFIED' });
  });

  it('8. a single-year cause can precede a century effect', () => {
    expect(
      checkChronology(
        date({ year: 1914, precision: 'YEAR' }),
        date({ year: 1900, precision: 'CENTURY' }),
      ),
    ).toEqual({ status: 'VERIFIED' });
  });

  it('9. a decade before the next decade is VERIFIED', () => {
    expect(
      checkChronology(
        date({ year: 1800, precision: 'DECADE' }),
        date({ year: 1810, precision: 'YEAR' }),
      ),
    ).toEqual({ status: 'VERIFIED' });
  });

  it('10. a later decade cannot cause an earlier year (VIOLATION)', () => {
    const result = checkChronology(
      date({ year: 2000, precision: 'DECADE' }),
      date({ year: 1810, precision: 'YEAR' }),
    );
    expect(result.status).toBe('VIOLATION');
  });

  it('11. a BCE cause can precede a CE effect', () => {
    expect(
      checkChronology(
        date({ year: -100, precision: 'YEAR' }),
        date({ year: 100, precision: 'YEAR' }),
      ),
    ).toEqual({ status: 'VERIFIED' });
  });

  it('12. a CE cause cannot precede a BCE effect (VIOLATION)', () => {
    const result = checkChronology(
      date({ year: 100, precision: 'YEAR' }),
      date({ year: -100, precision: 'YEAR' }),
    );
    expect(result.status).toBe('VIOLATION');
  });

  it('13. a BCE century cause can precede a CE effect', () => {
    expect(
      checkChronology(
        date({ year: -100, precision: 'CENTURY' }),
        date({ year: 100, precision: 'YEAR' }),
      ),
    ).toEqual({ status: 'VERIFIED' });
  });

  it('14. a null year with a non-UNKNOWN precision is UNVERIFIED', () => {
    expect(
      checkChronology(
        date({ year: null, precision: 'YEAR' }),
        date({ year: 1914, precision: 'YEAR' }),
      ),
    ).toEqual({ status: 'UNVERIFIED' });
  });

  it('15. decade start equal to effect year is VERIFIED (inclusive endpoints)', () => {
    expect(
      checkChronology(
        date({ year: 1910, precision: 'DECADE' }),
        date({ year: 1910, precision: 'YEAR' }),
      ),
    ).toEqual({ status: 'VERIFIED' });
  });
});
